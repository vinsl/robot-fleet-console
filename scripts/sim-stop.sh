#!/usr/bin/env bash
# Stops the simulator on this machine: SIGTERM to the process that holds the simulator's lock, then
# a wait of up to 30 s for it to exit. The simulator then says goodbye to the fleet and disconnects
# (docs/security/RUNBOOK_SIM.md). This script never sends SIGKILL.
#
# Usage: scripts/sim-stop.sh
#
# Exit status: 0 when no simulator runs here, or when the one running has exited; 1 when the lock
# holder is not a simulator, when the lock is unreadable, or when it is still running after 30 s.

set -euo pipefail
umask 077

readonly LOCK="${XDG_STATE_HOME:-${HOME}/.local/state}/fleet/sim.lock"
readonly GRACE_S=30

for tool in flock sed sleep tr grep head cut seq; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'sim-stop: %s is required (util-linux and coreutils)\n' "$tool" >&2
    exit 1
  }
done

# Prints the state letter of a process from /proc, or nothing when the process is gone. The command
# name sits in parentheses and may contain spaces, so the state is read after the last parenthesis.
process_state() {
  sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1
}

# Prints the process identifier in the lock file, after checking that it names a simulator. It
# returns 1 with a message on standard error otherwise, so the caller never signals an unchecked pid.
lock_holder() {
  local pid
  pid="$(head -n 1 "$LOCK" 2>/dev/null)" || pid=""
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "sim-stop: the lock file does not hold a process identifier" >&2
    return 1
  fi
  if ! tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -q 'fleet-agent'; then
    echo "sim-stop: the process holding the lock is not the simulator; nothing was stopped" >&2
    return 1
  fi
  printf '%s\n' "$pid"
}

if [ ! -e "$LOCK" ] || flock -n "$LOCK" true; then
  # Taking the lock succeeded, so no simulator holds it: the file is only a leftover.
  echo "no simulator running here"
  exit 0
fi

pid="$(lock_holder)" || exit 1
# The holder can exit and its identifier be reused between the check above and the signal. The
# holder is read and checked again immediately before the kill, which narrows that window to a few
# milliseconds. A window remains because /proc offers no atomic check-and-signal; it is accepted
# (THREAT_MODEL R37), and only a process of the same user could take the identifier in it.
recheck="$(lock_holder)" || exit 1
if [ "$recheck" != "$pid" ]; then
  echo "sim-stop: the lock holder changed; nothing was stopped" >&2
  exit 1
fi
kill -TERM "$pid"
echo "sim-stop: SIGTERM sent to the simulator, waiting up to ${GRACE_S} s"
for _ in $(seq 1 "$GRACE_S"); do
  state="$(process_state "$pid")"
  if [ -z "$state" ] || [ "$state" = "Z" ]; then
    echo "sim-stop: the simulator has stopped"
    exit 0
  fi
  sleep 1
done
echo "sim-stop: the simulator is still running after ${GRACE_S} s; check it on this machine" >&2
exit 1
