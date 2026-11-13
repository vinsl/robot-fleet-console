#!/usr/bin/env bash
# Creates the ephemeral operator and simulated robot of one deployed e2e run (ADR 0069). The Playwright scenario signs
# in as this operator through the real console, so the run uses the real user pool, the real API and the real IoT
# endpoint; nothing is stored between runs. Teardown (scripts/e2e-teardown.sh) deletes what this script creates.
#
# The passwords are generated here and never printed, except as ::add-mask:: lines in GitHub Actions, and they reach
# Cognito in a JSON document in a private file, so they never appear in a process list. The state file that the test
# reads is written in two phases, so that teardown can clean up even when this script stops half way. The simulator
# runs with an allowlisted environment: no CI or AWS variable reaches the agent. The telemetry ingest consumer is
# enabled for the run when it was disabled (ADR 0039, D5), and the state file records what it was before, so that
# teardown restores it and never disables a consumer that someone else enabled.
#
# Usage: CONSOLE_URL=https://CONSOLE_HOST AWS_REGION=REGION scripts/e2e-setup.sh
# Environment: GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT name the run (a local run uses the epoch time), GITHUB_ACTIONS
# enables the masks. Needs an AWS session allowed to call the Cognito admin actions and to invoke the robots function.
# Exit status: 0 done, 1 failed, 2 usage error.

set -euo pipefail
umask 077

readonly SITE_ID="paris-01"
readonly OPERATOR_GROUP="Operator"
readonly SAMPLE_MAP="packages/protocol/test/fixtures/site-map/sample-warehouse.geojson"
readonly CONSOLE_PATTERN='^https://[a-z0-9.-]+$'
readonly REGION_PATTERN='^[a-z]{2}-[a-z-]+-[0-9]+$'
readonly POOL_PATTERN='^[a-z]{2}-[a-z-]+-[0-9]+_[A-Za-z0-9]+$'
readonly RUN_PATTERN='^[0-9]{1,12}$'
readonly ATTEMPT_PATTERN='^[0-9]{1,3}$'
# The same e-mail shape the janitor sweeps: example.com is reserved, so no mail is ever sent to these users.
readonly E2E_EMAIL_PATTERN='^e2e-[0-9]+-[0-9]+@example\.com$'
readonly E2E_ROBOT_PATTERN='^e2e[0-9]+a[0-9]+-01$'
# With the e-mail as sign-in attribute, Cognito gives each user an opaque Username: a UUID.
readonly USERNAME_PATTERN='^[0-9a-fA-F-]{36}$'
# Users older than this are left by a crashed run; a run takes minutes, so two hours is far past any live run.
readonly STALE_SECONDS=7200
readonly CONNECT_TIMEOUT_S=30
# The exact key set of the runtime configuration (ADR 0048), with every value a string.
readonly CONFIG_SHAPE='keys == ["apiUrl","identityPoolId","region","userPoolClientId","userPoolId","wsUrl"] and all(.[]; type == "string")'

# Values filled in during the run. The secrets are set once and only used through the state file or Cognito.
CONSOLE_REGION=""
USER_POOL_ID=""
RUN_TAG=""
RUN_PREFIX=""
ROBOT_ID=""
ROBOT_NAME=""
EMAIL=""
TEMPORARY_PASSWORD=""
PASSWORD=""
SIM_PID=""
SIM_START=""
CONSUMER_WAS_ENABLED=""
STATE_DIR=""
ROOT=""

# Prints a message on stderr and exits 1. Messages never contain a secret, an e-mail, an account id or a key.
die() {
  echo "e2e-setup: $1" >&2
  exit 1
}

# Prints a warning on stderr. Used for the janitor, which must never block the run.
warn() {
  echo "e2e-setup: warning: $1" >&2
}

# Prints the usage on stderr and exits 2.
usage() {
  cat >&2 <<'EOF'
Usage: CONSOLE_URL=https://CONSOLE_HOST AWS_REGION=REGION scripts/e2e-setup.sh
EOF
  exit 2
}

# Registers a value with the GitHub Actions log masker before its first use, so that the runner hides it in the log.
# Outside GitHub Actions there is no masker and nothing is printed.
mask() {
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    printf '::add-mask::%s\n' "$1"
  fi
}

# Prints a 24-character password: 144 random bits from openssl, plus a fixed suffix that meets the pool policy. The
# base64 alphabet has no quote or backslash, so the value is safe inside the JSON state file without escaping.
new_secret() {
  local random
  random="$(openssl rand -base64 18)"
  printf '%s%s' "$random" 'Aa1!'
}

# Runs an AWS CLI command whose JSON input document arrives on stdin. The document goes through a file in a private
# directory, so the password never reaches a process list (same helper as bootstrap-admin.sh). The directory is removed
# on every exit of the call: on return, and on an interrupt, which also ends the run with status 130.
aws_with_json_input() {
  local dir status=0
  dir="$(umask 077 && mktemp -d)"
  # The path is expanded now on purpose: the local variable is gone when the trap fires.
  # shellcheck disable=SC2064
  trap "rm -rf -- '$dir'" RETURN
  # shellcheck disable=SC2064
  trap "rm -rf -- '$dir'; exit 130" INT TERM
  cat >"$dir/input.json"
  aws "$@" --cli-input-json "file://$dir/input.json" >/dev/null || status=$?
  rm -rf -- "$dir"
  trap - RETURN
  return "$status"
}

# Stops the simulator when the run fails after it started, so that a failed run never leaves a robot connected. A
# successful run keeps the simulator for the scenario; teardown stops it. The start time guards against a reused pid.
cleanup_on_failure() {
  local status=$?
  if ((status != 0)) && [[ -n "$SIM_PID" ]] && is_same_process "$SIM_PID" "$SIM_START"; then
    stop_group "$SIM_PID" || true
  fi
  return "$status"
}

# Checks the environment and the repository layout before anything is created. Every failure here exits 2 or 1
# before the first AWS call that writes.
validate_environment() {
  if [[ $# -ne 0 ]]; then
    usage
  fi
  if [[ -z "${CONSOLE_URL:-}" || -z "${AWS_REGION:-}" ]]; then
    echo "e2e-setup: CONSOLE_URL and AWS_REGION are required" >&2
    exit 2
  fi
  if [[ ! "$CONSOLE_URL" =~ $CONSOLE_PATTERN || ! "$AWS_REGION" =~ $REGION_PATTERN ]]; then
    echo "e2e-setup: CONSOLE_URL or AWS_REGION has an unexpected shape" >&2
    exit 2
  fi
  local tool
  for tool in aws curl jq openssl uv setsid; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required; see .devcontainer/post-create.sh"
  done
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  # shellcheck source=scripts/e2e-state-dir.sh
  . "$ROOT/scripts/e2e-state-dir.sh"
  # shellcheck source=scripts/e2e-process.sh
  . "$ROOT/scripts/e2e-process.sh"
}

# Reads the public runtime configuration of the console and checks its shape and its region. The pool id that comes
# from here is the only place the script learns the pool: it reads no Terraform state.
load_console_config() {
  local body
  body="$(curl -fsS --max-time 15 "$CONSOLE_URL/config.json")" ||
    die "config.json cannot be read from CONSOLE_URL"
  jq -e "$CONFIG_SHAPE" >/dev/null <<<"$body" || die "config.json does not have the expected shape"
  USER_POOL_ID="$(jq -r '.userPoolId' <<<"$body")"
  CONSOLE_REGION="$(jq -r '.region' <<<"$body")"
  if [[ ! "$USER_POOL_ID" =~ $POOL_PATTERN || ! "$CONSOLE_REGION" =~ $REGION_PATTERN ]]; then
    die "config.json holds an unexpected pool id or region"
  fi
  if [[ "$CONSOLE_REGION" != "$AWS_REGION" ]]; then
    die "the console is in another region than AWS_REGION"
  fi
}

# Deletes the e2e users left by a crashed run. The pool signs users in by e-mail, so the listing gives an opaque Username
# and the e-mail as an attribute: the e-mail is matched, and the user is deleted by its Username. A user is swept only
# when its e-mail has the e2e shape and it is older than the threshold, so a real account is never touched. The janitor is
# best effort: a failure is a warning. It reads the first page of the listing (60 users), which a run never exceeds.
sweep_stale_users() {
  local listing email username created created_s now deleted=0 failed=0
  if ! listing="$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" \
    --filter 'email ^= "e2e-"' --output json 2>/dev/null)"; then
    warn "the stale e2e users could not be listed"
    return 0
  fi
  now="$(date +%s)"
  while IFS=$'\t' read -r email username created; do
    [[ "$email" =~ $E2E_EMAIL_PATTERN && "$username" =~ $USERNAME_PATTERN && -n "$created" ]] || continue
    # An empty date would parse as today, so the guard above is what keeps a user without a date from being swept.
    created_s="$(date -u -d "$created" +%s 2>/dev/null)" || continue
    if ((now - created_s > STALE_SECONDS)); then
      if aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$username" >/dev/null 2>&1; then
        deleted=$((deleted + 1))
      else
        failed=$((failed + 1))
      fi
    fi
  done < <(jq -r '(.Users // [])[] | [
    (((.Attributes // []) | map(select(.Name == "email")) | .[0].Value) // ""),
    (.Username // ""),
    (.UserCreateDate // "")
  ] | @tsv' <<<"$listing")
  echo "e2e-setup: swept $deleted stale e2e user(s), $failed could not be deleted"
}

# Writes the state file in one of two phases: phase 1 holds only the non-secret intent, so that teardown knows what to
# delete; phase 2 adds the passwords and the simulator pid and start time. The file is written to a private temporary
# name, checked as JSON, and then renamed, so a reader never sees half of it. The values are validated before this call,
# so no escaping is needed; the JSON is built with printf and never passed through an argument of a process.
write_state() {
  local phase="$1" tmp
  tmp="$(mktemp "$STATE_DIR/state.json.XXXXXX")"
  {
    printf '{"consoleUrl":"%s","region":"%s","userPoolId":"%s","siteId":"%s","email":"%s","robotId":"%s","robotName":"%s"' \
      "$CONSOLE_URL" "$AWS_REGION" "$USER_POOL_ID" "$SITE_ID" "$EMAIL" "$ROBOT_ID" "$ROBOT_NAME"
    if [[ "$phase" == 2 ]]; then
      printf ',"temporaryPassword":"%s","password":"%s","simPid":%s,"simStart":%s' \
        "$TEMPORARY_PASSWORD" "$PASSWORD" "$SIM_PID" "$SIM_START"
      # Absent until the consumer has been looked at: teardown restores only a consumer recorded as disabled.
      if [[ -n "$CONSUMER_WAS_ENABLED" ]]; then
        printf ',"consumerWasEnabled":%s' "$CONSUMER_WAS_ENABLED"
      fi
    fi
    printf '}\n'
  } >"$tmp"
  if ! jq -e 'type == "object"' "$tmp" >/dev/null; then
    rm -f -- "$tmp"
    die "the state file could not be written"
  fi
  mv -f -- "$tmp" "$STATE_DIR/state.json"
}

# Creates the operator with the temporary password and no invitation, then adds it to the Operator group. The group is
# hard-coded: the e2e role cannot restrict the group in IAM, so the code is the control (ADR 0069).
create_user() {
  printf '{"UserPoolId":"%s","Username":"%s","UserAttributes":[{"Name":"email","Value":"%s"},{"Name":"email_verified","Value":"true"}],"TemporaryPassword":"%s","MessageAction":"SUPPRESS"}' \
    "$USER_POOL_ID" "$EMAIL" "$EMAIL" "$TEMPORARY_PASSWORD" |
    aws_with_json_input cognito-idp admin-create-user || die "the e2e user could not be created"
  if ! aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" \
    --username "$EMAIL" --group-name "$OPERATOR_GROUP" >/dev/null; then
    # Without its group the user is useless: remove it now. Teardown retries the deletion if this fails too.
    aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" >/dev/null 2>&1 || true
    die "the e2e user could not be added to the $OPERATOR_GROUP group"
  fi
}

# Registers the simulated robot with the production registration script. The kit lands in the operator's directory
# and its summary is discarded: the kit holds the private key and is never printed.
register_robot() {
  "$ROOT/scripts/robots-admin.sh" register --robot-id "$ROBOT_ID" --site-id "$SITE_ID" \
    --name "$ROBOT_NAME" --type SIM --design-date "$(date -u +%F)" --simulated true --actor e2e-ci >/dev/null ||
    die "the simulated robot could not be registered; teardown removes what was created"
}

# Starts one simulated robot with the production agent, in its own session and process group. The environment is an
# allowlist, so the robot has only its certificate, as in real life, and no CI or AWS credential reaches agent code. The
# pid and start time go to the state file right after the launch, so teardown can stop a simulator that never connected.
start_simulator() {
  local log="$STATE_DIR/sim.log" waited=0
  : >"$log"
  setsid env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    nohup uv run --frozen --project "$ROOT/agent" fleet-agent sim --count=1 --prefix="$RUN_PREFIX" \
    --site-id="$SITE_ID" --map="$ROOT/$SAMPLE_MAP" --fault-rate-per-hour=0 \
    --max-runtime-seconds=900 --seed=1 >"$log" 2>&1 &
  SIM_PID=$!
  # The process entry appears a moment after the fork; a short wait avoids reading an empty start time.
  while ! SIM_START="$(process_start_time "$SIM_PID")"; do
    if ! process_alive "$SIM_PID"; then
      die "the simulator exited at once"
    fi
    sleep 0.1
    waited=$((waited + 1))
    if ((waited > 50)); then
      die "the simulator start time cannot be read"
    fi
  done
  write_state 2
  waited=0
  while ((waited < CONNECT_TIMEOUT_S)); do
    if grep -q 'link.connected' "$log"; then
      return 0
    fi
    if ! process_alive "$SIM_PID"; then
      # The last lines help the operator; PEM blocks are dropped so that no key material reaches the log.
      tail -n 20 "$log" | sed -E '/BEGIN |PRIVATE KEY|CERTIFICATE/d' >&2 || true
      die "the simulator exited before the robot connected"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  die "the robot did not connect within $CONNECT_TIMEOUT_S seconds"
}

# Makes sure the telemetry consumer delivers the telemetry of the simulated robot. The state is read first and recorded
# before any change, so teardown knows what to restore even when the enable call fails. A consumer that is already
# enabled belongs to someone else's demo and is left as it is. A state other than Enabled or Disabled (for example a
# transition in progress) stops the run: guessing would risk a change that the owner does not expect.
enable_consumer() {
  local state
  state="$("$ROOT/scripts/demo-consumer.sh" status)" || die "the telemetry consumer state cannot be read"
  case "$state" in
    Enabled) CONSUMER_WAS_ENABLED=true ;;
    Disabled) CONSUMER_WAS_ENABLED=false ;;
    *) die "the telemetry consumer is $state, neither Enabled nor Disabled; the run stops" ;;
  esac
  write_state 2
  if [[ "$CONSUMER_WAS_ENABLED" == true ]]; then
    echo "e2e-setup: telemetry consumer already enabled, left as it is"
    return 0
  fi
  "$ROOT/scripts/demo-consumer.sh" enable >/dev/null ||
    die "the telemetry consumer could not be enabled; teardown restores it"
  echo "e2e-setup: telemetry consumer enabled for the run"
}

# Entry point: names the run, then creates the operator and robot in the order of the design, writing the state in
# two phases around the creations.
main() {
  validate_environment "$@"
  # Interrupts end the run through the exit path, so cleanup_on_failure stops a simulator that already started.
  trap 'cleanup_on_failure' EXIT
  trap 'exit 130' INT TERM
  load_console_config
  local run_digits="${GITHUB_RUN_ID:-$(date +%s)}" attempt="${GITHUB_RUN_ATTEMPT:-1}"
  if [[ ! "$run_digits" =~ $RUN_PATTERN || ! "$attempt" =~ $ATTEMPT_PATTERN ]]; then
    die "the run id or attempt has an unexpected shape"
  fi
  RUN_TAG="${run_digits}a${attempt}"
  RUN_PREFIX="e2e${RUN_TAG}"
  ROBOT_ID="${RUN_PREFIX}-01"
  ROBOT_NAME="E2E ${RUN_TAG}"
  EMAIL="e2e-${run_digits}-${attempt}@example.com"
  if [[ ! "$ROBOT_ID" =~ $E2E_ROBOT_PATTERN || ! "$EMAIL" =~ $E2E_EMAIL_PATTERN ]]; then
    die "the run names have an unexpected shape"
  fi

  sweep_stale_users
  STATE_DIR="$(e2e_state_dir)" || die "the state directory is not usable"
  write_state 1

  TEMPORARY_PASSWORD="$(new_secret)"
  PASSWORD="$(new_secret)"
  mask "$TEMPORARY_PASSWORD"
  mask "$PASSWORD"

  create_user
  register_robot
  start_simulator
  enable_consumer
  echo "e2e-setup: OK"
  echo "robot: $ROBOT_ID"
}

main "$@"
