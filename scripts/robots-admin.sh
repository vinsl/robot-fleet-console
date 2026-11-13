#!/usr/bin/env bash
# Registers and retires robots through the mfc-demo-robots function, invoked with the operator's own
# IAM session (ADR 0029, docs/security/RUNBOOK_ROBOTS.md). The answer to a registration carries the
# robot's private key, and AWS never stores that key: this script keeps the answer as the only copy,
# in a file that only the operator can read, and it never prints, logs or traces the kit.
#
# Usage:
#   robots-admin.sh register --robot-id ID --site-id ID --name NAME --type TYPE \
#     --design-date YYYY-MM-DD --simulated true|false --actor ACTOR
#   robots-admin.sh retire --robot-id ID --site-id ID --actor ACTOR
#
# Exit status: 0 done, 1 refused or failed, 2 usage error.

set -euo pipefail
# Every file this script creates (the kit above all) is private to the operator, whatever the caller's umask.
umask 077

readonly FUNCTION_NAME="mfc-demo-robots"
readonly KIT_ROOT="${HOME}/.fleet/robots"
readonly ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly DATE_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
readonly ACTOR_PATTERN='^[A-Za-z0-9._+-]{1,64}$'
readonly -a REGISTER_OPTIONS=(robot-id site-id name type design-date simulated actor)
readonly -a RETIRE_OPTIONS=(robot-id site-id actor)

# Options given on the command line, by name. Global so that every function reads the same values.
declare -A OPTS=()
# Private scratch directory of this run, removed on exit: it holds the invocation event and the
# answer of a retirement, and the answer of a registration is never written there.
WORK=""

# Prints the usage on stderr and exits with the given status.
usage() {
  local status="$1"
  cat >&2 <<'EOF'
Usage:
  robots-admin.sh register --robot-id ID --site-id ID --name NAME --type TYPE --design-date YYYY-MM-DD --simulated true|false --actor ACTOR
  robots-admin.sh retire --robot-id ID --site-id ID --actor ACTOR
EOF
  exit "$status"
}

# Reports a usage error, then the usage, and exits with status 2.
usage_error() {
  printf 'robots-admin: %s\n' "$1" >&2
  usage 2
}

# Reports a failure of the request or of the environment and exits with status 1.
fail() {
  printf 'robots-admin: %s\n' "$1" >&2
  exit 1
}

# Refuses to run without the tool: a missing jq would otherwise end the run half way.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

# Fills OPTS from the command line. Every option takes exactly one value and may appear once, and only
# the options of the command are accepted, so a misspelt option never silently becomes a default.
parse_options() {
  local command="$1"
  shift
  local -a allowed
  if [ "$command" = "register" ]; then
    allowed=("${REGISTER_OPTIONS[@]}")
  else
    allowed=("${RETIRE_OPTIONS[@]}")
  fi

  local flag key name known
  while [ "$#" -gt 0 ]; do
    flag="$1"
    case "$flag" in
      --*) ;;
      *) usage_error "unexpected argument: $flag" ;;
    esac
    [ "$#" -ge 2 ] || usage_error "option $flag needs a value"
    key="${flag#--}"
    known=0
    for name in "${allowed[@]}"; do
      if [ "$name" = "$key" ]; then
        known=1
      fi
    done
    [ "$known" -eq 1 ] || usage_error "option $flag is not valid for $command"
    [ -z "${OPTS[$key]+set}" ] || usage_error "option $flag is given twice"
    OPTS[$key]="$2"
    shift 2
  done

  for name in "${allowed[@]}"; do
    [ -n "${OPTS[$name]+set}" ] || usage_error "missing --$name"
  done
}

# Tells whether a value matches an anchored pattern. The pattern is passed in a variable, so that the
# regular expression is never quoted or interpreted as shell syntax.
matches() {
  [[ "$1" =~ $2 ]]
}

# Checks the values before the call. The function validates the whole request again with the shared
# schema; these checks only keep obvious typos away from it, and they give the operator a clear message.
validate_options() {
  local command="$1"
  matches "${OPTS[robot-id]}" "$ID_PATTERN" || usage_error "--robot-id must match $ID_PATTERN"
  matches "${OPTS[site-id]}" "$ID_PATTERN" || usage_error "--site-id must match $ID_PATTERN"
  matches "${OPTS[actor]}" "$ACTOR_PATTERN" || usage_error "--actor must match $ACTOR_PATTERN"
  if [ "$command" = "register" ]; then
    [ -n "${OPTS[name]}" ] || usage_error "--name must not be empty"
    [ -n "${OPTS[type]}" ] || usage_error "--type must not be empty"
    matches "${OPTS[design-date]}" "$DATE_PATTERN" || usage_error "--design-date must be YYYY-MM-DD"
    case "${OPTS[simulated]}" in
      true | false) ;;
      *) usage_error "--simulated must be true or false" ;;
    esac
  fi
}

# Writes the invocation event of the command to a file. jq quotes every value, so no argument can
# change the structure of the JSON.
write_payload() {
  local command="$1" file="$2"
  if [ "$command" = "register" ]; then
    jq -n \
      --arg actor "${OPTS[actor]}" \
      --arg robotId "${OPTS[robot-id]}" \
      --arg siteId "${OPTS[site-id]}" \
      --arg name "${OPTS[name]}" \
      --arg type "${OPTS[type]}" \
      --arg designDate "${OPTS[design-date]}" \
      --argjson simulated "${OPTS[simulated]}" \
      '{source: "mfc.admin", action: "robots.register", actor: $actor,
        body: {robotId: $robotId, siteId: $siteId, name: $name, type: $type,
               designDate: $designDate, simulated: $simulated}}' \
      >"$file"
  else
    jq -n \
      --arg actor "${OPTS[actor]}" \
      --arg robotId "${OPTS[robot-id]}" \
      --arg siteId "${OPTS[site-id]}" \
      '{source: "mfc.admin", action: "robots.retire", actor: $actor,
        body: {robotId: $robotId, siteId: $siteId}}' \
      >"$file"
  fi
}

# Invokes the function synchronously with the operator's session. One attempt only: the SDK would
# otherwise retry a read timeout, and a second call could run the same registration again. The read
# timeout is longer than the function's own 30 s limit, so a slow answer is not mistaken for a failure.
# A transport failure removes the response only while it is empty: a non-empty file may hold the kit,
# the only copy of the private key, and is never deleted here.
invoke() {
  local payload="$1" response="$2" metadata function_error
  if ! metadata="$(AWS_MAX_ATTEMPTS=1 aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 90 \
    --payload "fileb://$payload" \
    "$response")"; then
    [ -s "$response" ] || rm -f -- "$response"
    fail "the invocation did not complete: check the SSO session (aws sso login) and the region"
  fi
  function_error="$(jq -r '.FunctionError // empty' <<<"$metadata")" ||
    fail "aws lambda invoke returned an unexpected answer"
  if [ -n "$function_error" ]; then
    rm -f -- "$response"
    fail "the function raised an unhandled error; its log group is /aws/lambda/$FUNCTION_NAME"
  fi
}

# Prints the summary of the answer and nothing else. The kit (the private key) is never printed: the
# summary keeps the status and the robot, or the status and the problem. A refused answer is discarded.
report() {
  local response="$1"
  if jq -e '.ok == true and (.body.robot | type) == "object"' "$response" >/dev/null 2>&1; then
    jq -c '{status, robot: .body.robot}' "$response"
    return 0
  fi
  if jq -e '.ok == false and (.problem | type) == "object"' "$response" >/dev/null 2>&1; then
    jq -c '{status, problem}' "$response"
    rm -f -- "$response"
    exit 1
  fi
  rm -f -- "$response"
  fail "the function returned an answer that is not a result of this command"
}

# Creates a directory of the kit tree, private to the operator. The mode is set with chmod rather than left to
# the umask: on some file systems the umask is not applied to new directories (observed on the ext4 mounts of the
# development container, 2026-11-02), and mkdir -m would apply only to the last directory of a -p chain.
ensure_private_dir() {
  mkdir -p -- "$1"
  chmod 700 -- "$1"
}

# Registers a robot. The answer is written to the operator's directory for this robot, which is created
# private. An existing answer is never overwritten: the kit it holds may be the only copy.
register_robot() {
  local directory="$KIT_ROOT/${OPTS[robot-id]}"
  local response="$directory/register-response.json"
  ensure_private_dir "$HOME/.fleet"
  ensure_private_dir "$KIT_ROOT"
  ensure_private_dir "$directory"
  # Creating the answer here, with noclobber, refuses an existing answer in one atomic step, and gives the
  # file mode 600 before the kit is written into it. The mode is set explicitly: the umask is not enough.
  if ! (set -C; : >"$response") 2>/dev/null; then
    fail "an answer of a registration already exists for ${OPTS[robot-id]}; move it away before registering again"
  fi
  chmod 600 -- "$response"
  write_payload register "$WORK/payload.json"
  invoke "$WORK/payload.json" "$response"
  report "$response"
}

# Retires a robot. The answer is not a secret, so it lives in the private scratch directory of the run.
retire_robot() {
  local response="$WORK/retire-response.json"
  write_payload retire "$WORK/payload.json"
  invoke "$WORK/payload.json" "$response"
  report "$response"
}

# Entry point. Validation runs before the scratch directory is created, so a usage error leaves no trace.
main() {
  if [ "$#" -eq 0 ]; then
    usage 2
  fi
  local command="$1"
  shift
  case "$command" in
    register | retire) ;;
    help | -h | --help) usage 0 ;;
    *) usage_error "unknown command: $command" ;;
  esac

  require_tool aws
  require_tool jq
  parse_options "$command" "$@"
  validate_options "$command"

  WORK="$(mktemp -d)"
  trap 'rm -rf -- "$WORK"' EXIT

  case "$command" in
    register) register_robot ;;
    retire) retire_robot ;;
  esac
}

main "$@"
