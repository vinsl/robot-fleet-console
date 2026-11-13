#!/usr/bin/env bash
# Deletes what scripts/e2e-setup.sh created for one deployed e2e run (ADR 0069): the simulator, the simulated robot and
# the operator. It is the single cleanup path, used by the CI job after every run (also when the run failed) and by
# hand. The telemetry consumer is restored to Disabled only when the state records that the run found it disabled.
# Every step is best effort and runs even when an earlier one failed, so one failure never leaves the other
# resources behind; the exit status reports whether any step failed.
#
# The state file is kept when a step failed, so that running the target again retries the failed steps. It is removed
# only when every step succeeded. A run without a state file has nothing to clean and exits 0, so the target is safe to
# run twice.
#
# Usage: scripts/e2e-teardown.sh
# Exit status: 0 nothing left or everything deleted, 1 a step failed, 2 usage error.

set -euo pipefail
umask 077

readonly CONSOLE_REGION_PATTERN='^[a-z]{2}-[a-z-]+-[0-9]+$'
readonly POOL_PATTERN='^[a-z]{2}-[a-z-]+-[0-9]+_[A-Za-z0-9]+$'
readonly ROBOT_ID_PATTERN='^e2e[0-9]+a[0-9]+-01$'
readonly E2E_EMAIL_PATTERN='^e2e-[0-9]+-[0-9]+@example\.com$'
readonly SITE_ID="paris-01"
readonly PROBLEM_NOT_FOUND="urn:mfc:problem:robot-not-found"
readonly PROBLEM_CONFLICT="urn:mfc:problem:robot-state-conflict"
# A robot in a provisioning or retiring state is busy for a short while; one retry after this wait is enough.
readonly RETRY_DELAY_S=60

ROOT=""
STATE_DIR=""
STATE=""
FAILED=0
SIM_PID=""
SIM_START=""
ROBOT_ID=""
USER_POOL_ID=""
EMAIL=""
CONSUMER_WAS_ENABLED=""

# Prints a message on stderr and counts it as a failed step. The message never holds a secret or an account id.
step_failed() {
  echo "e2e-teardown: $1" >&2
  FAILED=1
}

# Prints the usage on stderr and exits 2.
usage() {
  echo "Usage: scripts/e2e-teardown.sh" >&2
  exit 2
}

# Checks the arguments and the tools, and resolves the state directory. Stops before any deletion when a tool is missing.
prepare() {
  if [[ $# -ne 0 ]]; then
    usage
  fi
  local tool
  for tool in aws jq; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "e2e-teardown: $tool is required; see .devcontainer/post-create.sh" >&2
      exit 1
    }
  done
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  # shellcheck source=scripts/e2e-state-dir.sh
  . "$ROOT/scripts/e2e-state-dir.sh"
  # shellcheck source=scripts/e2e-process.sh
  . "$ROOT/scripts/e2e-process.sh"
  STATE_DIR="$(e2e_state_dir)" || exit 1
  STATE="$STATE_DIR/state.json"
}

# Reads the fields the teardown needs from the state file, and validates each one before it is used. A state file that
# does not validate is refused: the run stops, and the file is kept for an operator to look at. The shapes are the ones
# the setup writes, so a value outside them never reaches a deletion.
read_state() {
  local region
  jq -e 'type == "object"' "$STATE" >/dev/null 2>&1 || {
    echo "e2e-teardown: the state file cannot be read; it is kept" >&2
    exit 1
  }
  ROBOT_ID="$(jq -r '.robotId // empty' "$STATE")"
  local site
  site="$(jq -r '.siteId // empty' "$STATE")"
  EMAIL="$(jq -r '.email // empty' "$STATE")"
  USER_POOL_ID="$(jq -r '.userPoolId // empty' "$STATE")"
  region="$(jq -r '.region // empty' "$STATE")"
  SIM_PID="$(jq -r '.simPid // empty' "$STATE")"
  SIM_START="$(jq -r '.simStart // empty' "$STATE")"
  if [[ -n "$ROBOT_ID" && ! "$ROBOT_ID" =~ $ROBOT_ID_PATTERN ]] || [[ -n "$site" && "$site" != "$SITE_ID" ]] ||
    [[ -n "$EMAIL" && ! "$EMAIL" =~ $E2E_EMAIL_PATTERN ]] ||
    [[ -n "$USER_POOL_ID" && ! "$USER_POOL_ID" =~ $POOL_PATTERN ]] ||
    [[ -n "$region" && ! "$region" =~ $CONSOLE_REGION_PATTERN ]] ||
    [[ -n "$SIM_PID" && ! "$SIM_PID" =~ ^[0-9]+$ ]] || [[ -n "$SIM_START" && ! "$SIM_START" =~ ^[0-9]+$ ]]; then
    echo "e2e-teardown: the state file holds an unexpected value; it is kept" >&2
    exit 1
  fi
  # jq's // operator would turn a false into an absent value, so the field is typed and read with has().
  if ! jq -e 'if has("consumerWasEnabled") then (.consumerWasEnabled | type == "boolean") else true end' "$STATE" \
    >/dev/null 2>&1; then
    echo "e2e-teardown: the state file holds an unexpected value; it is kept" >&2
    exit 1
  fi
  CONSUMER_WAS_ENABLED="$(jq -r 'if has("consumerWasEnabled") then (.consumerWasEnabled | tostring) else "" end' "$STATE")"
  # The state records the region of the run. The AWS CLI reads it from the environment, so it is set when absent.
  if [[ -z "${AWS_REGION:-}" && -n "$region" ]]; then
    export AWS_REGION="$region"
  fi
}

# Stops the simulator. It is signalled only when its pid still has the start time recorded by the setup, so a pid
# reused after a crash is never touched, and a state without a start time is refused for the same reason.
stop_simulator() {
  [[ -n "$SIM_PID" ]] || return 0
  if ! process_alive "$SIM_PID"; then
    echo "e2e-teardown: the simulator is not running"
    return 0
  fi
  if [[ -z "$SIM_START" ]] || ! is_same_process "$SIM_PID" "$SIM_START"; then
    echo "e2e-teardown: the pid in the state file is not the simulator; it is left alone"
    return 0
  fi
  if stop_group "$SIM_PID"; then
    echo "e2e-teardown: the simulator stopped"
  else
    step_failed "the simulator did not stop"
  fi
}

# Retires the robot through the production script, which keeps the id RETIRED so that it can never be reused. A robot
# that does not exist (never registered, or already retired) is a success. The kit is removed once the robot is retired,
# because the private key has no further use.
retire_robot() {
  [[ -n "$ROBOT_ID" ]] || return 0
  local attempt output problem
  for attempt in 1 2; do
    if output="$("$ROOT/scripts/robots-admin.sh" retire --robot-id "$ROBOT_ID" --site-id "$SITE_ID" --actor e2e-ci 2>/dev/null)"; then
      rm -rf -- "${HOME}/.fleet/robots/$ROBOT_ID"
      echo "e2e-teardown: robot retired"
      return 0
    fi
    problem="$(jq -r '.problem.type // empty' <<<"${output:-}" 2>/dev/null || true)"
    if [[ "$problem" == "$PROBLEM_NOT_FOUND" ]]; then
      rm -rf -- "${HOME}/.fleet/robots/$ROBOT_ID"
      echo "e2e-teardown: the robot was not registered or is already retired"
      return 0
    fi
    if [[ "$problem" != "$PROBLEM_CONFLICT" ]]; then
      break
    fi
    if ((attempt == 1)); then
      sleep "$RETRY_DELAY_S"
    fi
  done
  step_failed "the robot could not be retired; run make e2e-teardown again"
}

# Puts the telemetry consumer back to Disabled, but only when the run found it disabled: a consumer that was enabled
# before the run belongs to someone else's demo, and a state without the record (the setup stopped before it looked) is
# left alone too. A failure is counted like the other steps, so the steps before it have already run and the ones after
# it still run; the state file is then kept and the next run retries.
restore_consumer() {
  case "$CONSUMER_WAS_ENABLED" in
    false) ;;
    true)
      echo "e2e-teardown: telemetry consumer was enabled before the run, left enabled"
      return 0
      ;;
    *) return 0 ;;
  esac
  if "$ROOT/scripts/demo-consumer.sh" disable >/dev/null; then
    echo "e2e-teardown: telemetry consumer disabled again"
  else
    step_failed "the telemetry consumer could not be disabled; run scripts/demo-consumer.sh disable"
  fi
}

# Deletes the operator. A user that does not exist is a success, so a second run or a run that failed before the user
# was created is clean. Other errors are reported by their code only, never by their message.
delete_user() {
  [[ -n "$EMAIL" ]] || return 0
  local error code
  if error="$(aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" 2>&1 >/dev/null)"; then
    echo "e2e-teardown: operator deleted"
    return 0
  fi
  code="$(sed -n 's/.*An error occurred (\([A-Za-z]*\)).*/\1/p' <<<"$error" | head -n 1)"
  if [[ "$code" == UserNotFoundException ]]; then
    echo "e2e-teardown: the operator does not exist"
    return 0
  fi
  step_failed "the operator could not be deleted (${code:-unknown error}); run make e2e-teardown again"
}

# Entry point. Without a state file there is nothing to clean. Otherwise every step runs, and the state directory is
# removed only when all of them succeeded.
main() {
  prepare "$@"
  if [[ ! -f "$STATE" ]]; then
    echo "e2e-teardown: nothing to clean"
    exit 0
  fi
  read_state
  stop_simulator
  retire_robot
  delete_user
  restore_consumer
  if ((FAILED != 0)); then
    echo "e2e-teardown: some steps failed; the state file is kept for a retry" >&2
    exit 1
  fi
  rm -rf -- "$STATE_DIR"
  echo "e2e-teardown: OK"
}

main "$@"
