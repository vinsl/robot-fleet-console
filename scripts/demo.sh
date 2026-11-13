#!/usr/bin/env bash
# Starts the demo in one command: checks the AWS session, enables the ingest consumer, registers the
# missing simulated kits, starts the simulators in the background, waits until they hold their lock, then
# prints the links. Run again, it starts nothing new (the simulators are already running) and prints the links.
#
# Usage: SIM_N=9 scripts/demo.sh   (make demo sets SIM_N from N, default 9)
# Environment (optional): SIM_SITE_ID (paris-01), XDG_STATE_HOME (~/.local/state).
#
# Exit status: 0 done, 1 when a tool is missing or the AWS session is not usable, 2 for a usage error.
# The simulators outlive this script: `make demo-stop` stops them and disables the consumer.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly N="${SIM_N:-9}"
readonly SITE_ID="${SIM_SITE_ID:-paris-01}"
readonly SITE_ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}"
readonly STATE_DIR="${STATE_ROOT}/fleet/demo-ui"
readonly LOCK="${STATE_ROOT}/fleet/sim.lock"
readonly KIT_ROOT="${HOME}/.fleet/robots"
readonly START_WAIT_S=20

usage_error() {
  printf 'demo: %s\n' "$1" >&2
  exit 2
}

# Tells whether a simulator holds the lock, without taking it: the kernel lists the flock holders in
# /proc/locks as MAJOR:MINOR:INODE in hex (MAJOR:MINOR) and decimal (INODE). Taking the lock to test it
# would make a simulator starting at the same moment refuse to run; the Python probe does the same.
simulators_running() {
  [ -e "$LOCK" ] || return 1
  local device inode major minor identity
  # %d is the device of the file system (st_dev); the split is glibc's gnu_dev_major and gnu_dev_minor.
  device="$(stat -c %d "$LOCK")"
  inode="$(stat -c %i "$LOCK")"
  major=$(((device >> 8) & 0xfff))
  minor=$(((device & 0xff) | ((device >> 12) & 0xfffff00)))
  identity="$(printf '%02x:%02x:%s' "$major" "$minor" "$inode")"
  awk -v id="$identity" '$2 == "FLOCK" && $6 == id { found = 1 } END { exit !found }' /proc/locks
}

case "$N" in
  '' | *[!0-9]*) usage_error "SIM_N must be an integer from 1 to 20" ;;
esac
if [ "$N" -lt 1 ] || [ "$N" -gt 20 ]; then
  usage_error "SIM_N must be an integer from 1 to 20"
fi
[[ "$SITE_ID" =~ $SITE_ID_PATTERN ]] || usage_error "SIM_SITE_ID must match $SITE_ID_PATTERN"

for tool in aws uv flock timeout; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'demo: %s is required; see .devcontainer/post-create.sh\n' "$tool" >&2
    exit 1
  }
done

if ! timeout 10 aws sts get-caller-identity >/dev/null 2>&1; then
  printf 'demo: no usable AWS session. Run: aws sso login, then make demo again\n' >&2
  exit 1
fi

# Enabling is idempotent, and it runs on every call: a consumer disabled by an earlier stop, or by hand, is
# enabled again before the simulators are looked at.
"${ROOT}/scripts/demo-consumer.sh" enable

if simulators_running; then
  echo "demo: the simulators already run on this machine; nothing started"
else
  missing=0
  for index in $(seq 1 "$N"); do
    if [ ! -e "${KIT_ROOT}/$(printf 'sim-%02d' "$index")/register-response.json" ]; then
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    "${ROOT}/scripts/sim-provision.sh" "$N" --site-id "$SITE_ID"
  fi

  # The log is private, like every file the page writes; the simulator keeps running after this shell exits.
  mkdir -p -- "$STATE_DIR"
  chmod 700 -- "$STATE_DIR"
  SIM_N="$N" SIM_SITE_ID="$SITE_ID" nohup setsid bash "${ROOT}/scripts/sim.sh" \
    >>"${STATE_DIR}/sim.log" 2>&1 </dev/null &

  deadline=$((SECONDS + START_WAIT_S))
  until simulators_running; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'demo: the simulators did not take their lock within %s s; see %s/sim.log\n' \
        "$START_WAIT_S" "$STATE_DIR" >&2
      exit 1
    fi
    sleep 1
  done
  echo "demo: the simulators are running (${N} robots on ${SITE_ID}); they stop after 2 h"
fi

"${ROOT}/scripts/links.sh"
