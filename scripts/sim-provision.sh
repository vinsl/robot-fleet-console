#!/usr/bin/env bash
# Registers the simulated robots sim-01 to sim-NN through robots-admin.sh, with the operator's own
# IAM session (ADR 0029, ADR 0042). Run it on the machine that runs the simulator: the kits it writes
# never leave that machine. A kit that already exists is skipped, so the script can be run again.
#
# Usage: scripts/sim-provision.sh N [--site-id paris-01]
#
# Exit status: 0 done, 1 when a registration failed (the rest are not attempted), 2 usage error.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly KIT_ROOT="${HOME}/.fleet/robots"
readonly ACTOR_PATTERN='^[A-Za-z0-9._+-]{1,64}$'
readonly SITE_ID_PATTERN='^[a-z0-9-]{3,32}$'

usage() {
  cat >&2 <<'USAGE'
Usage:
  sim-provision.sh N [--site-id paris-01]
USAGE
  exit 2
}

usage_error() {
  printf 'sim-provision: %s\n' "$1" >&2
  usage
}

[ "$#" -ge 1 ] || usage
count="$1"
shift
site_id="paris-01"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --site-id)
      [ "$#" -ge 2 ] || usage_error "option --site-id needs a value"
      site_id="$2"
      shift 2
      ;;
    *) usage_error "unexpected argument: $1" ;;
  esac
done

case "$count" in
  '' | *[!0-9]*) usage_error "N must be an integer from 1 to 20" ;;
esac
if [ "$count" -lt 1 ] || [ "$count" -gt 20 ]; then
  usage_error "N must be an integer from 1 to 20"
fi
[[ "$site_id" =~ $SITE_ID_PATTERN ]] || usage_error "--site-id must match $SITE_ID_PATTERN"

actor="$(id -un)"
[[ "$actor" =~ $ACTOR_PATTERN ]] || usage_error "the operator name is not a valid actor"
design_date="$(date -u +%F)"

created=()
for index in $(seq 1 "$count"); do
  robot_id="$(printf 'sim-%02d' "$index")"
  if [ -e "${KIT_ROOT}/${robot_id}/register-response.json" ]; then
    echo "sim-provision: ${robot_id} already has a kit; skipped"
    continue
  fi
  if ! "${ROOT}/scripts/robots-admin.sh" register \
    --robot-id "$robot_id" \
    --site-id "$site_id" \
    --name "Sim $(printf '%02d' "$index")" \
    --type SIM \
    --design-date "$design_date" \
    --simulated true \
    --actor "$actor"; then
    printf 'sim-provision: the registration of %s failed; stopped here\n' "$robot_id" >&2
    printf 'sim-provision: created so far: %s\n' "${created[*]:-none}" >&2
    exit 1
  fi
  created+=("$robot_id")
done
echo "sim-provision: created ${created[*]:-none}"
