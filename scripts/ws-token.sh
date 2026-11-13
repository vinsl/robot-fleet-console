#!/usr/bin/env bash
# Issues a single-use WebSocket token for one user and one site, through the mfc-demo-ws-token function invoked
# with the operator's own IAM session (design section 4.5, THREAT_MODEL T25). M5 only: M6 replaces this path with
# the JWT authorizer on POST /ws-token.
#
# The token is printed on stdout, once, with the WebSocket URL. It is valid for 60 seconds and works once. The
# script never logs it, and its answer file lives in a private scratch directory that is removed on exit.
#
# Usage:
#   ws-token.sh --site-id ID --sub SUB --role Admin|Operator|Viewer
#
# Exit status: 0 issued, 1 refused or failed, 2 usage error.

set -euo pipefail
# Every file this script creates (the scratch answer above all) is private to the operator, whatever the caller's umask.
umask 077

readonly FUNCTION_NAME="mfc-demo-ws-token"
readonly ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly SUB_PATTERN='^[A-Za-z0-9-]{1,128}$'
readonly ROLE_PATTERN='^(Admin|Operator|Viewer)$'
# The session window copied into the token: the access token lifetime of M6 (FR-AUTH-4), 55 minutes here so that
# the handler's one-hour bound is never reached by clock drift.
readonly SESSION_SECONDS=3300

# Options given on the command line, by name. Global so that every function reads the same values.
declare -A OPTS=()
# Private scratch directory of this run, removed on exit.
WORK=""

# Prints the usage on stderr and exits with the given status.
usage() {
  local status="$1"
  cat >&2 <<'EOF'
Usage:
  ws-token.sh --site-id ID --sub SUB --role Admin|Operator|Viewer
EOF
  exit "$status"
}

# Reports a usage error, then the usage, and exits with status 2.
usage_error() {
  printf 'ws-token: %s\n' "$1" >&2
  usage 2
}

# Reports a failure of the request or of the environment and exits with status 1.
fail() {
  printf 'ws-token: %s\n' "$1" >&2
  exit 1
}

# Refuses to run without the tool: a missing jq would otherwise end the run half way.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

# Fills OPTS from the command line. Each option takes one value and may appear once.
parse_options() {
  local flag key
  while [ "$#" -gt 0 ]; do
    flag="$1"
    case "$flag" in
      --site-id | --sub | --role) ;;
      *) usage_error "unexpected argument: $flag" ;;
    esac
    [ "$#" -ge 2 ] || usage_error "option $flag needs a value"
    key="${flag#--}"
    [ -z "${OPTS[$key]+set}" ] || usage_error "option $flag is given twice"
    OPTS[$key]="$2"
    shift 2
  done
  [ -n "${OPTS[site-id]+set}" ] || usage_error "missing --site-id"
  [ -n "${OPTS[sub]+set}" ] || usage_error "missing --sub"
  [ -n "${OPTS[role]+set}" ] || usage_error "missing --role"
}

# Tells whether a value matches an anchored pattern. The pattern is passed in a variable, so that the
# regular expression is never quoted or interpreted as shell syntax.
matches() {
  [[ "$1" =~ $2 ]]
}

# Checks the values before the call. The function validates the whole request again; these checks keep obvious
# typos away from it and give the operator a clear message.
validate_options() {
  matches "${OPTS[site-id]}" "$ID_PATTERN" || usage_error "--site-id must match $ID_PATTERN"
  matches "${OPTS[sub]}" "$SUB_PATTERN" || usage_error "--sub must match $SUB_PATTERN"
  matches "${OPTS[role]}" "$ROLE_PATTERN" || usage_error "--role must be Admin, Operator or Viewer"
}

# Writes the invocation event to a file. jq quotes every value, so no argument can change the structure of the JSON.
# The session end is computed in UTC and written with millisecond precision, as the protocol expects.
write_payload() {
  local file="$1" session_expires_at correlation_id
  session_expires_at="$(date -u -d "@$(($(date +%s) + SESSION_SECONDS))" +%Y-%m-%dT%H:%M:%S.000Z)"
  correlation_id="ws-token-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  jq -n \
    --arg sub "${OPTS[sub]}" \
    --arg role "${OPTS[role]}" \
    --arg siteId "${OPTS[site-id]}" \
    --arg sessionExpiresAt "$session_expires_at" \
    --arg correlationId "$correlation_id" \
    '{principal: {sub: $sub, role: $role, siteIds: [$siteId], sessionExpiresAt: $sessionExpiresAt},
      request: {siteId: $siteId}, correlationId: $correlationId}' \
    >"$file"
}

# Invokes the function synchronously with the operator's session. One attempt only, as robots-admin.sh does.
invoke() {
  local payload="$1" response="$2" metadata function_error
  if ! metadata="$(AWS_MAX_ATTEMPTS=1 aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 30 \
    --payload "fileb://$payload" \
    "$response")"; then
    fail "the invocation did not complete: check the SSO session (aws sso login) and the region"
  fi
  function_error="$(jq -r '.FunctionError // empty' <<<"$metadata")" ||
    fail "aws lambda invoke returned an unexpected answer"
  if [ -n "$function_error" ]; then
    fail "the function raised an unhandled error; its log group is /aws/lambda/$FUNCTION_NAME"
  fi
}

# Prints the url and the token of a successful answer. A refusal prints its status and problem, never the body.
report() {
  local response="$1"
  if jq -e '.statusCode == 200 and (.body | type) == "object"' "$response" >/dev/null 2>&1; then
    jq -r '"url: \(.body.url)\ntoken: \(.body.token)"' "$response"
    return 0
  fi
  if jq -e '(.statusCode | type) == "number" and (.body | type) == "object"' "$response" >/dev/null 2>&1; then
    jq -r '"refused: status \(.statusCode), \(.body.title // "no title"), correlation \(.body.correlationId // "none")"' \
      "$response" >&2
    exit 1
  fi
  fail "the function returned an answer that is not a token response"
}

# Entry point. Validation runs before the scratch directory is created, so a usage error leaves no trace.
main() {
  if [ "$#" -eq 0 ]; then
    usage 2
  fi
  case "$1" in
    help | -h | --help) usage 0 ;;
  esac
  require_tool aws
  require_tool jq
  require_tool od
  parse_options "$@"
  validate_options

  WORK="$(mktemp -d)"
  trap 'rm -rf -- "$WORK"' EXIT
  write_payload "$WORK/payload.json"
  invoke "$WORK/payload.json" "$WORK/response.json"
  report "$WORK/response.json"
}

main "$@"
