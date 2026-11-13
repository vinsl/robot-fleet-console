#!/usr/bin/env bash
# Writes the active map of a site to a file: the map the console shows, which the simulator must drive
# its robots on (ADR 0042, docs/security/RUNBOOK_SIM.md). It reads the site profile and the pinned version
# from the fleet table, then the object version the console validated, with the operator's own IAM session
# (like sim-provision.sh and robots-admin.sh). Nothing is printed but identifiers and the outcome.
#
# The stored checksum is checked before the file is written, so a map that changed under its record is
# refused. The file is written under a temporary name in the same directory and renamed into place, so a
# reader never sees a partial map.
#
# Usage: scripts/fetch-active-map.sh SITE_ID OUTPUT_FILE
# Exit status: 0 written; 1 refused or failed (no active map, unexpected stored data, failed read);
# 2 usage error.

set -euo pipefail
# Every file the run creates is private to the operator, whatever the caller's umask.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly STACK_DIR="${ROOT}/infra/envs/demo"
readonly SITE_ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly REGION_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
readonly TABLE_PATTERN='^[A-Za-z0-9_.-]{3,255}$'
readonly BUCKET_PATTERN='^mfc-demo-site-maps-[a-z0-9-]+$'
readonly VERSION_PATTERN='^[1-9][0-9]{0,5}$'
readonly VERSION_ID_PATTERN='^[A-Za-z0-9._-]{1,1024}$'
readonly CHECKSUM_PATTERN='^[a-f0-9]{64}$'
# Same bound as the console's upload policy and the API: a larger object is not a map.
readonly MAX_BYTES=2000000
# Terraform outputs of the stack, read once by main and queried by output_value.
OUTPUTS=""
# Temporary file of the download. Global so that the exit trap can remove it.
TMP_FILE=""

# Prints a usage error on standard error and exits with status 2.
usage_error() {
  printf 'fetch-active-map: %s\n' "$1" >&2
  printf 'Usage: scripts/fetch-active-map.sh SITE_ID OUTPUT_FILE\n' >&2
  exit 2
}

# Prints a message on standard error and exits 1. Stored values are never printed, only their names.
die() {
  printf 'fetch-active-map: %s\n' "$1" >&2
  exit 1
}

# Prints the value of one Terraform output, after checking it against a pattern. Refuses when it is absent.
output_value() {
  local name="$1" pattern="$2" value
  value="$(jq -er --arg name "$name" '.[$name].value | select(type == "string" and . != "")' <<<"$OUTPUTS")" ||
    die "the Terraform output $name is missing; deploy the stack first"
  if [[ ! "$value" =~ $pattern ]]; then
    die "the Terraform output $name has an unexpected format"
  fi
  printf '%s\n' "$value"
}

# Prints one attribute of a DynamoDB item returned by get-item, or nothing when the item or attribute is absent.
# The attribute type is named (S or N) so that a value of the wrong type reads as absent and is refused.
item_attribute() {
  local item="$1" name="$2" type="$3"
  jq -r --arg name "$name" --arg type "$type" '.Item[$name][$type] // empty' <<<"$item"
}

# Entry point: checks the arguments and the tools, reads the stack and the site, downloads the active version,
# checks it against its recorded checksum, and renames it into place.
main() {
  local tool
  for tool in aws jq sha256sum stat terraform; do
    command -v "$tool" >/dev/null 2>&1 || {
      printf 'fetch-active-map: %s is required; see .devcontainer/post-create.sh\n' "$tool" >&2
      exit 1
    }
  done

  [ "$#" -eq 2 ] || usage_error "two arguments are required: SITE_ID and OUTPUT_FILE"
  local site_id="$1" output="$2"
  [[ "$site_id" =~ $SITE_ID_PATTERN ]] || usage_error "SITE_ID must match $SITE_ID_PATTERN"
  case "$output" in
    -*) usage_error "OUTPUT_FILE must not start with a dash" ;;
  esac
  [ ! -L "$output" ] || usage_error "OUTPUT_FILE must not be a symlink"
  [ ! -d "$output" ] || usage_error "OUTPUT_FILE must not be a directory"
  local out_dir
  out_dir="$(dirname -- "$output")"
  [ -d "$out_dir" ] || usage_error "the directory of OUTPUT_FILE does not exist"

  aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS session; run 'aws sso login' first"

  OUTPUTS="$(terraform -chdir="$STACK_DIR" output -json 2>/dev/null)" ||
    die "the Terraform outputs are unavailable; deploy the stack first"
  local region table bucket
  region="$(output_value region "$REGION_PATTERN")"
  table="$(output_value fleet_table_name "$TABLE_PATTERN")"
  bucket="$(output_value site_maps_bucket_name "$BUCKET_PATTERN")"
  export AWS_REGION="$region"

  # The profile holds the active version. A site without one has nothing to drive the robots on.
  local profile_key profile version
  profile_key="$(jq -cn --arg pk "SITE#${site_id}" '{pk: {S: $pk}, sk: {S: "META"}}')"
  profile="$(aws dynamodb get-item --table-name "$table" --key "$profile_key" --consistent-read \
    --output json)" || die "the site profile could not be read"
  version="$(item_attribute "$profile" activeVersion N)"
  if [ -z "$version" ]; then
    die "site ${site_id} has no active map; validate and activate a map in the console, then run this again"
  fi
  [[ "$version" =~ $VERSION_PATTERN ]] || die "the active version of site ${site_id} has an unexpected format"

  # The map version item is keyed by its version, zero-padded to six digits (the API's layout).
  local padded map_key map_item status s3_key version_id checksum
  padded="$(printf '%06d' "$((10#$version))")"
  map_key="$(jq -cn --arg pk "SITE#${site_id}" --arg sk "MAP#${padded}" '{pk: {S: $pk}, sk: {S: $sk}}')"
  map_item="$(aws dynamodb get-item --table-name "$table" --key "$map_key" --consistent-read \
    --output json)" || die "the map version could not be read"
  status="$(item_attribute "$map_item" status S)"
  s3_key="$(item_attribute "$map_item" s3Key S)"
  version_id="$(item_attribute "$map_item" s3VersionId S)"
  checksum="$(item_attribute "$map_item" sha256 S)"
  [ "$status" = "VALID" ] || die "the active map of site ${site_id} is not valid; activate a validated map in the console"
  [ "$s3_key" = "sites/${site_id}/maps/${padded}.geojson" ] ||
    die "the stored key of the active map has an unexpected format"
  [[ "$version_id" =~ $VERSION_ID_PATTERN ]] || die "the stored version of the active map has an unexpected format"
  [[ "$checksum" =~ $CHECKSUM_PATTERN ]] || die "the stored checksum of the active map has an unexpected format"

  # The download lands next to the output, so that the final rename stays on one file system.
  TMP_FILE="$(mktemp "${out_dir}/.active-map.XXXXXX")"
  trap 'rm -f -- "$TMP_FILE"' EXIT
  aws s3api get-object --bucket "$bucket" --key "$s3_key" --version-id "$version_id" "$TMP_FILE" \
    >/dev/null || die "the stored map of site ${site_id} could not be read"

  if [ "$(stat -c %s -- "$TMP_FILE")" -gt "$MAX_BYTES" ]; then
    die "the stored map of site ${site_id} is larger than the accepted size"
  fi
  local actual
  actual="$(sha256sum -- "$TMP_FILE" | cut -d ' ' -f 1)"
  if [ "$actual" != "$checksum" ]; then
    die "the stored map of site ${site_id} does not match its recorded checksum; activate the map again in the console"
  fi

  mv -f -- "$TMP_FILE" "$output"
  printf 'fetch-active-map: wrote the active map (version %s) of site %s\n' "$version" "$site_id"
}

main "$@"
