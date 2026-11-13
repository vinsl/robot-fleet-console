#!/usr/bin/env bash
# Runs the simulated fleet on this machine: SIM_N robots, each with its kit under ~/.fleet/robots
# (ADR 0042, docs/security/RUNBOOK_SIM.md). The Makefile checks SIM_N first; this script checks that
# the kits exist, reminds the operator when the ingest consumer is off, and then hands over to the
# agent, whose exit status becomes the status of this script.
#
# Usage: SIM_N=9 scripts/sim.sh
# The robots drive on the map the console shows: the active map of the site, fetched with the operator's
# own session by fetch-active-map.sh into ~/.cache/fleet (XDG_CACHE_HOME is honoured). When the fetch fails,
# the run stops: a silent fallback would put the robots on a map the console does not show.
#
# Environment (all optional): SIM_SITE_ID (paris-01), SIM_MAP (unset or empty: the active map; sample: the
# protocol's sample map; any other value: that GeoJSON file), SIM_FAULT_RATE (6), SIM_MAX_RUNTIME_S (7200, at
# most 14400), SIM_SEED (1).
# Every value is checked here before the agent sees it, and passed as --option=value, so a value
# can never be read as another option.
#
# Exit status: the agent's status once it runs; 1 when a tool is missing; 2 for a usage error or a
# kit that is missing.

set -euo pipefail
# Every file the run creates is private to the operator, whatever the caller's umask.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly KIT_ROOT="${HOME}/.fleet/robots"
readonly SITE_ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly FAULT_RATE_PATTERN='^[0-9]{1,4}(\.[0-9]{1,3})?$'
readonly RUNTIME_PATTERN='^[0-9]{1,6}$'
readonly RUNTIME_CAP_S=14400
readonly SEED_PATTERN='^-?[0-9]{1,10}$'
readonly N="${SIM_N:-}"
readonly SITE_ID="${SIM_SITE_ID:-paris-01}"
readonly SAMPLE_MAP="${ROOT}/packages/protocol/test/fixtures/site-map/sample-warehouse.geojson"
readonly ACTIVE_MAP_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/fleet"
readonly MAP_SETTING="${SIM_MAP:-}"
readonly FAULT_RATE="${SIM_FAULT_RATE:-6}"
readonly MAX_RUNTIME="${SIM_MAX_RUNTIME_S:-7200}"
readonly SEED="${SIM_SEED:-1}"

# Reports a usage error on standard error and exits with status 2.
usage_error() {
  printf 'sim: %s\n' "$1" >&2
  exit 2
}

case "$N" in
  '' | *[!0-9]*) usage_error "SIM_N must be an integer from 1 to 20" ;;
esac
if [ "$N" -lt 1 ] || [ "$N" -gt 20 ]; then
  usage_error "SIM_N must be an integer from 1 to 20"
fi
[[ "$SITE_ID" =~ $SITE_ID_PATTERN ]] || usage_error "SIM_SITE_ID must match $SITE_ID_PATTERN"
[[ "$FAULT_RATE" =~ $FAULT_RATE_PATTERN ]] ||
  usage_error "SIM_FAULT_RATE must be a decimal number, such as 6 or 0.5"
[[ "$MAX_RUNTIME" =~ $RUNTIME_PATTERN ]] ||
  usage_error "SIM_MAX_RUNTIME_S must be a whole number of seconds"
if [ "$MAX_RUNTIME" -lt 1 ] || [ "$MAX_RUNTIME" -gt "$RUNTIME_CAP_S" ]; then
  usage_error "SIM_MAX_RUNTIME_S must be from 1 to ${RUNTIME_CAP_S}"
fi
[[ "$SEED" =~ $SEED_PATTERN ]] || usage_error "SIM_SEED must be an integer"
case "$MAP_SETTING" in
  '' | sample) ;;
  -*) usage_error "SIM_MAP must not start with a dash" ;;
  *)
    [ -f "$MAP_SETTING" ] && [ ! -L "$MAP_SETTING" ] ||
      usage_error "SIM_MAP must name a regular file, not a symlink"
    ;;
esac
if ! command -v uv >/dev/null 2>&1; then
  printf 'sim: uv is required; see .devcontainer/post-create.sh\n' >&2
  exit 1
fi

# Every kit must exist before anything connects: a missing one is named, and the fix is printed.
missing=()
for index in $(seq 1 "$N"); do
  robot_id="$(printf 'sim-%02d' "$index")"
  if [ ! -e "${KIT_ROOT}/${robot_id}/register-response.json" ]; then
    missing+=("$robot_id")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'sim: missing kits: %s\n' "${missing[*]}" >&2
  printf 'sim: register them first, on this machine: scripts/sim-provision.sh %s --site-id %s\n' \
    "$N" "$SITE_ID" >&2
  exit 2
fi

# The map is resolved once the kits are known, so a run with missing kits makes no AWS call.
MAP="$SAMPLE_MAP"
case "$MAP_SETTING" in
  sample) ;;
  '')
    mkdir -p -- "$ACTIVE_MAP_DIR"
    active_map="${ACTIVE_MAP_DIR}/active-map-${SITE_ID}.geojson"
    if "${ROOT}/scripts/fetch-active-map.sh" "$SITE_ID" "$active_map"; then
      MAP="$active_map"
    else
      printf 'sim: the active map of %s could not be fetched (see above).\n' "$SITE_ID" >&2
      printf 'sim: fix the fetch, or set SIM_MAP=sample (sample map) or SIM_MAP=<file> to choose a map.\n' >&2
      exit 1
    fi
    ;;
  *) MAP="$MAP_SETTING" ;;
esac

# The reminder is read-only and skipped without credentials, so a run never waits on AWS.
if command -v aws >/dev/null 2>&1 && timeout 10 aws sts get-caller-identity >/dev/null 2>&1; then
  consumer="$("${ROOT}/scripts/demo-consumer.sh" status 2>/dev/null || true)"
  if [ "$consumer" != "Enabled" ]; then
    printf 'sim: the ingest consumer is not enabled (%s); run make demo-start to see live data\n' \
      "${consumer:-unknown}" >&2
  fi
fi

exec uv run --project "${ROOT}/agent" fleet-agent sim \
  --count="$N" \
  --site-id="$SITE_ID" \
  --map="$MAP" \
  --fault-rate-per-hour="$FAULT_RATE" \
  --max-runtime-seconds="$MAX_RUNTIME" \
  --seed="$SEED"
