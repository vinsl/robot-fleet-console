#!/usr/bin/env bash
# Enables, disables or reports the telemetry ingest consumer: the SQS event source mapping of the
# Lambda mfc-demo-ingest-telemetry (ADR 0039, D5). Disabling stops the polling and the fan-out, which
# is what `make demo-stop` relies on. Terraform ignores the mapping's enabled flag, so a deploy never
# turns the consumer back on (R38): `make demo-start` does.
#
# Usage: scripts/demo-consumer.sh enable|disable|status
# Environment: DEMO_CONSUMER_WAIT_S, the seconds to wait for the state to settle (default 60).
#
# Exit status: 0 done (disabling a disabled consumer is a no-op), 1 for a failure or a timeout,
# 2 for a usage error.

set -euo pipefail
umask 077

readonly FUNCTION_NAME="mfc-demo-ingest-telemetry"
readonly POLL_S=2
readonly WAIT_PATTERN='^[0-9]+$'

usage() {
  cat >&2 <<'USAGE'
Usage:
  demo-consumer.sh enable|disable|status
USAGE
  exit 2
}

fail() {
  printf 'demo-consumer: %s\n' "$1" >&2
  exit 1
}

action="${1:-}"
case "$action" in
  enable | disable | status) ;;
  *) usage ;;
esac
# A stray argument would be ignored silently, so it is refused like a wrong action.
[ "$#" -eq 1 ] || usage

wait_s="${DEMO_CONSUMER_WAIT_S:-60}"
[[ "$wait_s" =~ $WAIT_PATTERN ]] || {
  printf 'demo-consumer: DEMO_CONSUMER_WAIT_S must be a whole number of seconds\n' >&2
  exit 2
}

command -v aws >/dev/null 2>&1 || fail "aws is required; see .devcontainer/post-create.sh"
command -v timeout >/dev/null 2>&1 || fail "timeout is required (GNU coreutils)"
# The call is bounded, so a stalled network reports a failure instead of hanging the target.
timeout 10 aws sts get-caller-identity >/dev/null 2>&1 ||
  fail "no AWS credentials, or the call timed out: run aws sso login, then retry"

uuid="$(aws lambda list-event-source-mappings \
  --function-name "$FUNCTION_NAME" \
  --query 'EventSourceMappings[0].UUID' \
  --output text)" || fail "cannot list the event source mappings"
if [ -z "$uuid" ] || [ "$uuid" = "None" ]; then
  fail "no event source mapping for ${FUNCTION_NAME}"
fi

mapping_state() {
  aws lambda get-event-source-mapping --uuid "$uuid" --query State --output text
}

current="$(mapping_state)" || fail "cannot read the state of the mapping"
if [ "$action" = "status" ]; then
  echo "$current"
  exit 0
fi

if [ "$action" = "disable" ]; then
  target="Disabled"
  flag="--no-enabled"
else
  target="Enabled"
  flag="--enabled"
fi
if [ "$current" = "$target" ]; then
  echo "demo-consumer: already ${target}"
  exit 0
fi

aws lambda update-event-source-mapping --uuid "$uuid" "$flag" >/dev/null ||
  fail "cannot update the mapping"

deadline=$((SECONDS + wait_s))
while :; do
  current="$(mapping_state)" || fail "cannot read the state of the mapping"
  if [ "$current" = "$target" ]; then
    echo "demo-consumer: ${target}"
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "still ${current} after ${wait_s} s; check the mapping in the AWS console"
  fi
  sleep "$POLL_S"
done
