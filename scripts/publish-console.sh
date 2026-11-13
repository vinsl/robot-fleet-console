#!/usr/bin/env bash
# Builds the console, writes its runtime configuration from the deployed stack, and publishes it to the private
# console bucket behind CloudFront (ADR 0046, ADR 0048). Run from the operator's IAM Identity Center session;
# CI does not publish (THREAT_MODEL R55).
#
# Order matters: the new objects go up first, then index.html and config.json, then the CloudFront invalidation of
# the two files that change, and only then the objects of the previous build are deleted. A browser that reads the
# new index.html finds its assets, and an old one still finds its own.
#
# Usage: publish-console.sh   (or make publish-console)
# Exit status: 0 published, 1 refused or failed.

set -euo pipefail

readonly STACK_DIR="infra/envs/demo"
readonly CONSOLE_PACKAGE="@mfc/console"
readonly DIST_DIR="apps/console/dist"
readonly REGION_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
readonly BUCKET_PATTERN='^mfc-demo-console-[a-z0-9-]+$'
readonly DISTRIBUTION_PATTERN='^[A-Z0-9]+$'
readonly API_PATTERN='^https://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$'
readonly WS_PATTERN='^wss://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(/[A-Za-z0-9_.-]+)?$'
readonly POOL_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+_[A-Za-z0-9]+$'
readonly CLIENT_PATTERN='^[a-z0-9]+$'
readonly IDENTITY_POOL_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+:[0-9a-f-]+$'
# Content-hashed assets never change, so the browser and CloudFront may keep them for one year.
readonly ASSET_CACHE="public,max-age=31536000,immutable"
# Files outside assets/ can change under the same name, so browsers and CloudFront always revalidate them.
readonly STATIC_CACHE="no-cache"
# Terraform outputs of the stack, read once by main and queried by output_value.
OUTPUTS=""

# Prints a message on stderr and exits 1. Values of the stack are never printed, only their names.
die() {
  echo "publish-console: $1" >&2
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
  echo "$value"
}

# Uploads the build without its two mutable files. Hashed assets are immutable for a year; the other root files
# (a copied public file, for example) may change under the same name, so they are never cached. The first pass
# runs without --delete; main passes --delete only after the invalidation.
upload_build() {
  local bucket="$1"
  shift
  aws s3 sync "$DIST_DIR/assets" "s3://$bucket/assets" --cache-control "$ASSET_CACHE" "$@"
  aws s3 sync "$DIST_DIR" "s3://$bucket" --exclude 'assets/*' --exclude index.html --exclude config.json \
    --cache-control "$STATIC_CACHE" "$@"
}

# Entry point: reads the stack, builds, writes config.json, checks the build, uploads, then invalidates.
main() {
  local tool
  for tool in aws jq pnpm terraform; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required; see .devcontainer/post-create.sh"
  done

  # Relative paths below need the repository root, whatever the caller's directory.
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS session; run 'aws sso login' first"

  OUTPUTS="$(terraform -chdir="$STACK_DIR" output -json 2>/dev/null)" ||
    die "the Terraform outputs are unavailable; deploy the stack first"

  local region bucket distribution api_url ws_url pool client identity_pool
  region="$(output_value region "$REGION_PATTERN")"
  bucket="$(output_value console_bucket_name "$BUCKET_PATTERN")"
  distribution="$(output_value console_distribution_id "$DISTRIBUTION_PATTERN")"
  api_url="$(output_value api_endpoint "$API_PATTERN")"
  ws_url="$(output_value ws_url "$WS_PATTERN")"
  pool="$(output_value user_pool_id "$POOL_PATTERN")"
  client="$(output_value user_pool_client_id "$CLIENT_PATTERN")"
  identity_pool="$(output_value identity_pool_id "$IDENTITY_POOL_PATTERN")"
  export AWS_REGION="$region"

  pnpm --filter "$CONSOLE_PACKAGE" build

  if [[ ! -f "$DIST_DIR/index.html" || ! -d "$DIST_DIR/assets" ]]; then
    die "the build did not produce $DIST_DIR/index.html and assets"
  fi

  # Public identifiers only: the configuration is downloaded by every browser and must never hold a secret.
  jq -n \
    --arg apiUrl "$api_url" \
    --arg wsUrl "$ws_url" \
    --arg region "$region" \
    --arg userPoolId "$pool" \
    --arg userPoolClientId "$client" \
    --arg identityPoolId "$identity_pool" \
    '{apiUrl: $apiUrl, wsUrl: $wsUrl, region: $region, userPoolId: $userPoolId, userPoolClientId: $userPoolClientId, identityPoolId: $identityPoolId}' \
    >"$DIST_DIR/config.json"

  upload_build "$bucket"
  aws s3 cp "$DIST_DIR/index.html" "s3://$bucket/index.html" \
    --cache-control "$STATIC_CACHE" --content-type "text/html; charset=utf-8"
  aws s3 cp "$DIST_DIR/config.json" "s3://$bucket/config.json" \
    --cache-control "$STATIC_CACHE" --content-type "application/json"

  local invalidation
  invalidation="$(aws cloudfront create-invalidation --distribution-id "$distribution" \
    --paths /index.html /config.json --query Invalidation.Id --output text)" ||
    die "the CloudFront invalidation failed; the new files are uploaded, rerun to invalidate"

  # The previous build's objects go last, once the new index.html is the one CloudFront serves.
  upload_build "$bucket" --delete
  echo "publish-console: published; invalidation $invalidation requested for /index.html and /config.json"
}

main "$@"
