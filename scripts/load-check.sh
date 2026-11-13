#!/usr/bin/env bash
# Load check of the live path (design M5 section 11): simulated robots run for a fixed time, the WebSocket
# probe measures what a console receives, and the read-only CloudWatch metrics of the same window are
# compared with the pass criteria. One table is printed and written, with the probe summary, to a private
# file under the operator's state directory.
#
# Usage:
#   load-check.sh run --site-id ID --sub SUB --role Admin|Operator|Viewer --ws-api-id ID \
#     [--robots N] [--seconds S]
#   load-check.sh report --start YYYY-MM-DDTHH:MM:SSZ --end YYYY-MM-DDTHH:MM:SSZ --ws-api-id ID
#
# `run` checks the account and the ingest consumer, starts the simulator with `make sim`, runs the probe for
# S seconds (its first 60 s are a warm-up and are not measured), stops the simulator it started, then reads
# the metrics of the window. `report` only reads the metrics of a window that already happened.
#
# Environment (required): MFC_EXPECTED_ACCOUNT_ID, the twelve-digit account the session must be in. The AWS
# CLI reads the credentials and the region itself. Every AWS call here is read-only (STS identity, the
# consumer state, CloudWatch statistics): the ingest consumer is never changed here, `make demo-stop` does
# that (R38).
#
# Exit status: 0 every criterion holds (a WARN is recorded, not a failure), 1 a criterion fails or a check
# cannot run, 2 usage error.

set -euo pipefail
umask 077

readonly SETTLE_S="${LOAD_CHECK_SETTLE_S:-180}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly NAME_PREFIX="mfc-demo"
readonly SIM_ROBOTS_MAX=20
readonly SIM_FAULT_RATE_PER_HOUR=6
readonly DEFAULT_SECONDS=600
readonly WARMUP_S=60
readonly SIM_START_CHECK_S=5
readonly SIM_RUNTIME_MARGIN_S=120
readonly SECONDS_MIN=120
readonly SECONDS_MAX=3600
readonly WINDOW_MAX_S=21600
readonly P95_TARGET_MS=1000
readonly P95_LIMIT_MS=1500
readonly SITE_ID_PATTERN='^[a-z0-9-]{3,32}$'
readonly SUB_PATTERN='^[A-Za-z0-9-]{1,128}$'
readonly ROLE_PATTERN='^(Admin|Operator|Viewer)$'
readonly WS_API_ID_PATTERN='^[a-z0-9]{6,12}$'
readonly ACCOUNT_PATTERN='^[0-9]{12}$'
readonly NUMBER_PATTERN='^[0-9]{1,6}$'
readonly TIME_PATTERN='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$'
readonly STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/fleet/load-check"
# The four robot topic rules of the IoT module (ADR 0031) and the queues and tables of the demo stack.
readonly IOT_RULES=(mfc_demo_telemetry mfc_demo_events mfc_demo_acks mfc_demo_presence)
readonly DYNAMO_TABLES=(fleet events connections)
readonly DLQ_QUEUES=(telemetry-dlq ingest-events-dlq iot-rule-errors)

# Options given on the command line, by name. Global, so that every check reads the same values.
declare -A OPTS=()
# Scratch directory of this run (probe output, simulator log), removed on exit.
WORK=""
# Process identifier of the simulator this run started; empty when none runs under this run.
SIM_PID=""
# Window of the metrics, UTC ISO 8601, set before any metric is read.
WINDOW_START=""
WINDOW_END=""
# WebSocket API id of the window, and the metrics namespace of the Powertools metrics.
WS_API_ID=""
readonly METRICS_NAMESPACE="$NAME_PREFIX"
# Rows of the result table: "check<TAB>observed<TAB>criterion<TAB>status".
ROWS=()

# Prints the usage of both commands on standard error.
usage_text() {
  cat >&2 <<'USAGE'
Usage:
  load-check.sh run --site-id ID --sub SUB --role Admin|Operator|Viewer --ws-api-id ID [--robots N] [--seconds S]
  load-check.sh report --start YYYY-MM-DDTHH:MM:SSZ --end YYYY-MM-DDTHH:MM:SSZ --ws-api-id ID
USAGE
}

# Reports a usage error on standard error, then the usage, and exits with status 2.
usage_error() {
  printf 'load-check: %s\n' "$1" >&2
  usage_text
  exit 2
}

# Reports a failure of the request or of the environment on standard error and exits with status 1.
fail() {
  printf 'load-check: %s\n' "$1" >&2
  exit 1
}

# Refuses to run without a tool, so that a missing jq does not end the run half way.
require_tools() {
  local tool
  for tool in aws jq node make timeout date sleep; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required; see .devcontainer/post-create.sh"
  done
}

# Fills OPTS from the command line. Each option takes exactly one value and may appear once. Only the
# options listed in $1 are accepted, so a misspelt option never silently becomes a default.
parse_options() {
  local allowed=" $1 "
  shift
  local flag key
  while [ "$#" -gt 0 ]; do
    flag="$1"
    case "$flag" in
      --*) ;;
      *) usage_error "unexpected argument: $flag" ;;
    esac
    key="${flag#--}"
    [[ "$allowed" == *" ${key} "* ]] || usage_error "unknown option: $flag"
    [ "$#" -ge 2 ] || usage_error "option $flag needs a value"
    case "$2" in
      --*) usage_error "option $flag needs a value" ;;
    esac
    [ -z "${OPTS[$key]+set}" ] || usage_error "option $flag is given twice"
    OPTS["$key"]="$2"
    shift 2
  done
}

# Checks that an option is present and matches its pattern. The value is never echoed: a bad value may be a
# secret typed in the wrong place.
require_option() {
  local key="$1" pattern="$2"
  [ -n "${OPTS[$key]+set}" ] || usage_error "--$key is required"
  [[ "${OPTS[$key]}" =~ $pattern ]] || usage_error "--$key is not valid"
}

# Checks the environment every command needs: the expected account id, then the tools.
require_environment() {
  [ -n "${MFC_EXPECTED_ACCOUNT_ID:-}" ] || usage_error "MFC_EXPECTED_ACCOUNT_ID must be set to the expected account id"
  [[ "$MFC_EXPECTED_ACCOUNT_ID" =~ $ACCOUNT_PATTERN ]] || usage_error "MFC_EXPECTED_ACCOUNT_ID must be twelve digits"
  require_tools
}

# Refuses to run when the session is not in the expected account. The id is never printed, and the STS call
# is bounded, so a stalled network reports a failure instead of hanging.
check_account() {
  local account
  account="$(timeout 15 aws sts get-caller-identity --query Account --output text 2>/dev/null)" ||
    fail "no AWS credentials, or the call timed out: run aws sso login, then retry"
  [ "$account" = "$MFC_EXPECTED_ACCOUNT_ID" ] ||
    fail "the session is not in the expected AWS account (MFC_EXPECTED_ACCOUNT_ID); refusing to run"
}

# Refuses to run unless the ingest consumer is enabled: with it off, the run measures nothing. The state is
# read with the read-only script and never changed here.
check_consumer() {
  local state
  state="$(bash "${ROOT}/scripts/demo-consumer.sh" status 2>/dev/null)" ||
    fail "cannot read the ingest consumer state"
  [ "$state" = "Enabled" ] || fail "the ingest consumer is ${state}, not Enabled; run make demo-start, then retry"
}

# Checks the probe runtime: Node 24 or later, and the tsx loader installed with the protocol package.
check_probe_runtime() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 24 ] || fail "Node 24 or later is required for the probe"
  [ -d "${ROOT}/packages/protocol/node_modules/tsx" ] || fail "the tsx loader is missing; run pnpm install, then retry"
}

# Starts the simulator in the background under this run, through the operator's make target, so that the run
# uses the same checks, kits and logs as a session started by hand.
start_simulator() {
  local robots="$1" seconds="$2"
  SIM_FAULT_RATE="$SIM_FAULT_RATE_PER_HOUR" SIM_MAX_RUNTIME_S="$((WARMUP_S + seconds + SIM_RUNTIME_MARGIN_S))" \
    make -C "$ROOT" --no-print-directory sim N="$robots" >"${WORK}/sim.log" 2>&1 &
  SIM_PID="$!"
}

# Stops the simulator this run started, with the script the operator uses: SIGTERM only, so that the robots
# say goodbye. Returns non-zero when the simulator is still running after its grace period.
stop_simulator() {
  local pid="$SIM_PID" status=0
  SIM_PID=""
  [ -n "$pid" ] || return 0
  bash "${ROOT}/scripts/sim-stop.sh" >&2 || status=$?
  if [ "$status" -eq 0 ]; then
    wait "$pid" 2>/dev/null || true
  fi
  return "$status"
}

# Runs on every exit: stops a simulator this run still holds, and removes the scratch directory.
cleanup() {
  if [ -n "$SIM_PID" ]; then
    stop_simulator || printf 'load-check: the simulator is still running; check it with scripts/sim-stop.sh\n' >&2
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

# Runs the probe from the protocol package, where the tsx loader resolves the TypeScript schemas. Its JSON line
# goes to the scratch file. Returns the probe's exit status; the table judges the summary.
run_probe() {
  local seconds="$1" status=0
  (
    cd "${ROOT}/packages/protocol" &&
      exec node --import tsx "${ROOT}/scripts/ws-probe.mjs" \
        --site-id "${OPTS[site-id]}" --sub "${OPTS[sub]}" --role "${OPTS[role]}" \
        --seconds "$seconds" --warmup-seconds "$WARMUP_S" --max-p95-ms "$P95_LIMIT_MS"
  ) >"${WORK}/probe.json" || status=$?
  return "$status"
}

# Prints the sum, or the maximum, of one CloudWatch metric over the window, one datapoint per minute. A window
# without datapoints is zero: CloudWatch has no point for a metric that did not move. The dimension is optional
# (the account-level IoT metric has none). A failed read stops the run: it is never recorded as a pass.
cw_value() {
  local namespace="$1" metric="$2" statistic="$3" dim_name="$4" dim_value="$5" dim2_name="${6:-}" dim2_value="${7:-}"
  local -a args=(cloudwatch get-metric-statistics --namespace "$namespace" --metric-name "$metric"
    --start-time "$WINDOW_START" --end-time "$WINDOW_END" --period 60 --statistics "$statistic" --output json)
  local filter='[.Datapoints[].Maximum] | max // 0'
  if [ "$statistic" = "Sum" ]; then
    filter='[.Datapoints[].Sum] | add // 0'
  fi
  if [ -n "$dim_name" ]; then
    args+=(--dimensions "Name=${dim_name},Value=${dim_value}")
    if [ -n "$dim2_name" ]; then
      args+=("Name=${dim2_name},Value=${dim2_value}")
    fi
  fi
  aws "${args[@]}" | jq -er "$filter" || fail "cannot read the CloudWatch metric ${metric}"
}

# Prints PASS when the observed value is below the limit, FAIL otherwise. jq compares the numbers, so decimals
# are exact.
below() {
  jq -rn --argjson value "$1" --argjson limit "$2" 'if $value < $limit then "PASS" else "FAIL" end'
}

# Adds one row to the table.
add_row() {
  ROWS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4")
}

# Adds the rows of the metrics of the window, one per criterion of design section 11. Counts are integers, so
# "below 1" means zero.
check_metrics() {
  local value a b dlq table rule operation

  value="$(cw_value AWS/Lambda Throttles Sum FunctionName "${NAME_PREFIX}-ingest-telemetry")"
  add_row "ingest-telemetry throttles" "$value" "0" "$(below "$value" 1)"

  value="$(cw_value AWS/Lambda Errors Sum FunctionName "${NAME_PREFIX}-ingest-telemetry")"
  add_row "ingest-telemetry errors" "$value" "0" "$(below "$value" 1)"

  value="$(cw_value AWS/SQS ApproximateAgeOfOldestMessage Maximum QueueName "${NAME_PREFIX}-telemetry")"
  add_row "telemetry queue oldest message (s)" "$value" "< 10 s" "$(below "$value" 10)"

  for dlq in "${DLQ_QUEUES[@]}"; do
    value="$(cw_value AWS/SQS ApproximateNumberOfMessagesVisible Maximum QueueName "${NAME_PREFIX}-${dlq}")"
    add_row "${dlq} visible messages (max)" "$value" "0" "$(below "$value" 1)"
  done

  for table in "${DYNAMO_TABLES[@]}"; do
    # ThrottledRequests is published per table and operation, so the table alone returns no datapoint.
    a=0
    for operation in PutItem UpdateItem DeleteItem BatchWriteItem GetItem Query; do
      b="$(cw_value AWS/DynamoDB ThrottledRequests Sum TableName "${NAME_PREFIX}-${table}" Operation "$operation")"
      a="$(jq -rn --argjson a "$a" --argjson b "$b" '$a + $b')"
    done
    b="$(cw_value AWS/DynamoDB WriteThrottleEvents Sum TableName "${NAME_PREFIX}-${table}")"
    value="$(jq -rn --argjson a "$a" --argjson b "$b" '$a + $b')"
    add_row "dynamodb ${table} throttles" "$value" "0" "$(below "$value" 1)"
  done

  value=0
  for rule in "${IOT_RULES[@]}"; do
    a="$(cw_value AWS/IoT RuleMessageThrottled Sum RuleName "$rule")"
    value="$(jq -rn --argjson a "$value" --argjson b "$a" '$a + $b')"
  done
  add_row "iot rule messages throttled" "$value" "0" "$(below "$value" 1)"

  value="$(cw_value AWS/IoT Connect.Throttle Sum "" "")"
  add_row "iot connect throttles" "$value" "0" "$(below "$value" 1)"

  a="$(cw_value AWS/ApiGateway IntegrationError Sum ApiId "$WS_API_ID")"
  b="$(cw_value AWS/ApiGateway ExecutionError Sum ApiId "$WS_API_ID")"
  value="$(jq -rn --argjson a "$a" --argjson b "$b" '$a + $b')"
  add_row "websocket integration and execution errors" "$value" "0" "$(below "$value" 1)"

  check_fan_out
}

# Adds the fan-out row: the failed share of pushes must stay under one percent. With no fan-out at all the
# window measured nothing, which is a failure rather than a pass.
check_fan_out() {
  local sent failed empty ratio
  sent="$(cw_value "$METRICS_NAMESPACE" FanOutSent Sum service ingest-telemetry)"
  failed="$(cw_value "$METRICS_NAMESPACE" FanOutFailed Sum service ingest-telemetry)"
  empty="$(jq -rn --argjson s "$sent" --argjson f "$failed" '$s + $f == 0')"
  if [ "$empty" = "true" ]; then
    add_row "fan-out failed share" "no fan-out in window" "< 1 %" "FAIL"
    return 0
  fi
  ratio="$(jq -rn --argjson s "$sent" --argjson f "$failed" '((100 * $f / ($s + $f)) * 100 | round) / 100')"
  add_row "fan-out failed share (%)" "$ratio" "< 1 %" "$(below "$ratio" 1)"
}

# Adds the probe rows. A missing probe result is a FAIL: the latency is the point of the test. Between the
# target and the limit the latency is WARN: it is recorded with the batching explanation (design section 11).
check_probe() {
  local probe_file="$1" verdict p95 duplicates status
  if [ -z "$probe_file" ] || ! jq -e . "$probe_file" >/dev/null 2>&1; then
    add_row "probe verdict" "no probe result" "PASS" "FAIL"
    add_row "telemetry to screen p95 (ms)" "no probe result" "< ${P95_TARGET_MS} ms" "FAIL"
    return 0
  fi
  verdict="$(jq -r '.verdict' "$probe_file")"
  status="FAIL"
  if [ "$verdict" = "PASS" ]; then
    status="PASS"
  fi
  add_row "probe verdict" "$verdict" "PASS" "$status"
  p95="$(jq -r '.latencyMs.p95 // empty' "$probe_file")"
  if [ -z "$p95" ]; then
    add_row "telemetry to screen p95 (ms)" "no sample" "< ${P95_TARGET_MS} ms" "FAIL"
  else
    status="$(jq -rn --argjson v "$p95" --argjson target "$P95_TARGET_MS" --argjson limit "$P95_LIMIT_MS" \
      'if $v < $target then "PASS" elif $v <= $limit then "WARN" else "FAIL" end')"
    add_row "telemetry to screen p95 (ms)" "$p95" "< ${P95_TARGET_MS} ms" "$status"
  fi
  duplicates="$(jq -r '.samples.duplicates // 0' "$probe_file")"
  add_row "duplicate samples seen by the probe" "$duplicates" "reported" "INFO"
}

# Prints the window and the table on standard output.
render_table() {
  local row check observed criterion status
  printf 'window: %s to %s (UTC)\n' "$WINDOW_START" "$WINDOW_END"
  printf '%-48s %-22s %-14s %s\n' "CHECK" "OBSERVED" "CRITERION" "STATUS"
  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r check observed criterion status <<<"$row"
    printf '%-48s %-22s %-14s %s\n' "$check" "$observed" "$criterion" "$status"
  done
}

# Prints the table, writes it with the probe summary to a private file, and returns 1 when a row failed. The
# probe line is the single JSON summary of the run: it holds no token and no URL.
publish_table() {
  local probe_file="$1" stamp summary_file failures=0 row status
  for row in "${ROWS[@]}"; do
    status="${row##*$'\t'}"
    if [ "$status" = "FAIL" ]; then
      failures=$((failures + 1))
    fi
  done
  render_table
  stamp="$(date -u -d "$WINDOW_END" +%Y%m%dT%H%M%SZ)"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  summary_file="${STATE_DIR}/${stamp}.txt"
  # The mode is set explicitly: some file systems ignore the umask (see robots-admin.sh).
  : >"$summary_file"
  chmod 600 "$summary_file"
  {
    render_table
    if [ -n "$probe_file" ] && jq -e . "$probe_file" >/dev/null 2>&1; then
      printf 'probe: %s\n' "$(jq -c . "$probe_file")"
    fi
  } >"$summary_file"
  printf 'summary written to %s\n' "$summary_file"
  if [ "$failures" -gt 0 ]; then
    return 1
  fi
}

# Reads the metrics of the window (WINDOW_START, WINDOW_END), adds the probe rows, prints and writes the table.
report_window() {
  local probe_file="$1"
  ROWS=()
  check_metrics
  check_probe "$probe_file"
  publish_table "$probe_file"
}

# Checks that a window is well formed: both ends are UTC timestamps, the end follows the start, and the window
# is at most six hours. Epoch seconds come from GNU date, which also rejects impossible dates.
check_window() {
  local start="$1" end="$2" start_s end_s
  [[ "$start" =~ $TIME_PATTERN ]] || usage_error "--start must be a UTC timestamp such as 2026-11-02T10:00:00Z"
  [[ "$end" =~ $TIME_PATTERN ]] || usage_error "--end must be a UTC timestamp such as 2026-11-02T10:11:00Z"
  start_s="$(date -u -d "$start" +%s 2>/dev/null)" || usage_error "--start is not a valid date"
  end_s="$(date -u -d "$end" +%s 2>/dev/null)" || usage_error "--end is not a valid date"
  [ "$end_s" -gt "$start_s" ] || usage_error "--end must be after --start"
  [ "$((end_s - start_s))" -le "$WINDOW_MAX_S" ] || usage_error "the window must be at most six hours"
}

# Runs one load check: preflight, simulator, probe, stop, metrics of the window.
cmd_run() {
  parse_options "site-id sub role ws-api-id robots seconds" "$@"
  require_option site-id "$SITE_ID_PATTERN"
  require_option sub "$SUB_PATTERN"
  require_option role "$ROLE_PATTERN"
  require_option ws-api-id "$WS_API_ID_PATTERN"
  local robots="${OPTS[robots]:-$SIM_ROBOTS_MAX}" seconds="${OPTS[seconds]:-$DEFAULT_SECONDS}"
  [[ "$robots" =~ $NUMBER_PATTERN ]] || usage_error "--robots must be a whole number"
  [ "$robots" -ge 1 ] && [ "$robots" -le "$SIM_ROBOTS_MAX" ] || usage_error "--robots must be from 1 to ${SIM_ROBOTS_MAX}"
  [[ "$seconds" =~ $NUMBER_PATTERN ]] || usage_error "--seconds must be a whole number"
  [ "$seconds" -ge "$SECONDS_MIN" ] && [ "$seconds" -le "$SECONDS_MAX" ] ||
    usage_error "--seconds must be from ${SECONDS_MIN} to ${SECONDS_MAX}"
  require_environment
  check_probe_runtime
  check_account
  check_consumer
  WS_API_ID="${OPTS[ws-api-id]}"

  WORK="$(mktemp -d)"
  trap cleanup EXIT
  WINDOW_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start_simulator "$robots" "$seconds"
  sleep "$SIM_START_CHECK_S"
  if ! kill -0 "$SIM_PID" 2>/dev/null; then
    local status=0
    wait "$SIM_PID" 2>/dev/null || status=$?
    SIM_PID=""
    fail "the simulator stopped at start (exit ${status}); run make sim by hand to see why"
  fi

  local probe_status=0 report_status=0
  run_probe "$seconds" || probe_status=$?
  stop_simulator || fail "the simulator did not stop within its grace period; check it with scripts/sim-stop.sh"
  WINDOW_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # CloudWatch publishes Lambda, SQS, DynamoDB and IoT metrics with a delay of a few minutes: reading at once
  # would miss the end of the window and could pass a failing run.
  sleep "$SETTLE_S"

  report_window "${WORK}/probe.json" || report_status=$?
  if [ "$probe_status" -ne 0 ] || [ "$report_status" -ne 0 ]; then
    exit 1
  fi
}

# Reads the metrics of a window that already happened. There is no probe result, so the latency row is
# not measured and does not fail the report.
cmd_report() {
  parse_options "start end ws-api-id" "$@"
  require_option ws-api-id "$WS_API_ID_PATTERN"
  [ -n "${OPTS[start]+set}" ] || usage_error "--start is required"
  [ -n "${OPTS[end]+set}" ] || usage_error "--end is required"
  check_window "${OPTS[start]}" "${OPTS[end]}"
  require_environment
  check_account
  WS_API_ID="${OPTS[ws-api-id]}"
  WINDOW_START="${OPTS[start]}"
  WINDOW_END="${OPTS[end]}"
  ROWS=()
  check_metrics
  add_row "telemetry to screen p95 (ms)" "not measured" "< ${P95_TARGET_MS} ms" "N/A"
  publish_table ""
}

case "${1:-}" in
  run)
    shift
    cmd_run "$@"
    ;;
  report)
    shift
    cmd_report "$@"
    ;;
  *)
    usage_error "expected the command run or report"
    ;;
esac
