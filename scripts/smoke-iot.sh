#!/usr/bin/env bash
# Post-deploy check of the robot identity in AWS IoT Core (THREAT_MODEL R20, SEC-ID-1, ADR 0029, ADR 0030).
# make smoke runs it after the trail and alarm checks. Every AWS call is a List, Describe or Get, so the
# read-only deploy role is enough and the account is never changed.
#
# It fails when:
#   - IoT v2 logging is not enabled at ERROR;
#   - one of the four robot topic rules is missing or disabled (ADR 0031);
#   - the IoT policies of the account are not exactly mfc-demo-robot;
#   - an ACTIVE certificate is not attached to exactly one thing, which must be an mfc-demo- thing,
#     or does not carry exactly the policy mfc-demo-robot;
#   - the thing of an ACTIVE certificate has no ACTIVE registry record of its robot that lists the certificate.
# An INACTIVE certificate is a warning: an interrupted registration leaves one, and it has no rights (ADR 0029).
#
# The check runs from the certificates to the registry. A registry record that is ACTIVE without any
# certificate is not detected, because that would need a full scan of the fleet table.

set -euo pipefail
umask 077

readonly ROBOT_POLICY="mfc-demo-robot"
readonly THING_PREFIX="mfc-demo-"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root

# Names read from the Terraform outputs of the demo root, and the registry table they name.
FLEET_TABLE=""
RULES_JSON=""

# Reports a failed check on stderr and exits with status 1.
fail() {
  printf 'smoke-iot: %s\n' "$1" >&2
  exit 1
}

# Reports a state that needs an operator's attention without failing the deploy.
warn() {
  printf '::warning::smoke-iot: %s\n' "$1"
}

# Refuses to run without a tool, so that a missing jq does not end the run half way.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

# Reads the table and the rule names from the Terraform outputs, so that the check follows the
# deployed names and never a copy of them. The rule count is the four rules of ADR 0031.
read_outputs() {
  local outputs
  outputs="$(terraform -chdir="$repo_root/infra/envs/demo" output -json)" ||
    fail "Terraform outputs are unavailable in infra/envs/demo; run the deploy first"
  FLEET_TABLE="$(jq -er '.fleet_table_name.value | select(type == "string" and . != "")' <<<"$outputs")" ||
    fail "fleet_table_name is missing from the Terraform outputs"
  RULES_JSON="$(jq -ec '.iot_rule_names.value | select(type == "array" and length == 4 and all(type == "string"))' <<<"$outputs")" ||
    fail "iot_rule_names must list the four robot rules"
}

# The v2 logging must be on at ERROR: refused connections leave a trace, and it stays quiet otherwise.
check_logging() {
  local logging level disabled
  logging="$(aws iot get-v2-logging-options --output json)" || fail "cannot read the IoT v2 logging options"
  level="$(jq -r '.defaultLogLevel' <<<"$logging")"
  disabled="$(jq -r '.disableAllLogs' <<<"$logging")"
  if [ "$level" != "ERROR" ] || [ "$disabled" != "false" ]; then
    fail "IoT v2 logging must be enabled at ERROR (level: $level, disabled: $disabled)"
  fi
}

# Every robot rule must exist and be enabled, or telemetry and events would be dropped without a trace.
check_rules() {
  local rule rule_json disabled
  while IFS= read -r rule; do
    rule_json="$(aws iot get-topic-rule --rule-name "$rule" --output json)" ||
      fail "rule $rule is missing or cannot be read"
    disabled="$(jq -r '.rule.ruleDisabled' <<<"$rule_json")"
    if [ "$disabled" != "false" ]; then
      fail "rule $rule is not enabled"
    fi
  done < <(jq -r '.[]' <<<"$RULES_JSON")
}

# The account holds one IoT policy, the robot policy (THREAT_MODEL R20). A policy created by hand is a
# second identity model, and this check is the live half of scripts/check-iot-inventory.sh.
check_policies() {
  local policies
  policies="$(aws iot list-policies --output json)" || fail "cannot list the IoT policies"
  jq -e --arg policy "$ROBOT_POLICY" '[.policies[].policyName] == [$policy]' <<<"$policies" >/dev/null ||
    fail "the IoT policies of the account must be exactly $ROBOT_POLICY"
}

# Checks one ACTIVE certificate: one thing that is a robot's, the robot policy and nothing else, and a
# registry record of that robot that is ACTIVE and lists the certificate (ADR 0029, ADR 0030).
check_active_certificate() {
  local id="$1" arn="$2" things thing policies attributes robot_id site_id record
  things="$(aws iot list-principal-things --principal "$arn" --output json)" ||
    fail "cannot list the things of certificate $id"
  thing="$(jq -r --arg prefix "$THING_PREFIX" \
    '.things as $things | if ($things | length) == 1 and ($things[0] | startswith($prefix)) then $things[0] else empty end' \
    <<<"$things")"
  [ -n "$thing" ] || fail "ACTIVE certificate $id must be attached to exactly one ${THING_PREFIX}* thing"

  policies="$(aws iot list-attached-policies --target "$arn" --output json)" ||
    fail "cannot list the policies of certificate $id"
  jq -e --arg policy "$ROBOT_POLICY" '[.policies[].policyName] == [$policy]' <<<"$policies" >/dev/null ||
    fail "ACTIVE certificate $id must carry exactly the policy $ROBOT_POLICY"

  attributes="$(aws iot describe-thing --thing-name "$thing" --output json)" ||
    fail "cannot describe the thing of certificate $id"
  robot_id="$(jq -r '.attributes.robotId // empty' <<<"$attributes")"
  site_id="$(jq -r '.attributes.siteId // empty' <<<"$attributes")"
  if [ -z "$robot_id" ] || [ -z "$site_id" ] || [ "$thing" != "${THING_PREFIX}${robot_id}" ]; then
    fail "the thing of ACTIVE certificate $id lacks the robotId and siteId of its robot"
  fi

  # The record key is the site partition and the robot sort key (ADR 0029, adapters of the robots function).
  record="$(aws dynamodb get-item --table-name "$FLEET_TABLE" --consistent-read --output json \
    --key "$(jq -nc --arg pk "SITE#$site_id" --arg sk "ROBOT#$robot_id" '{pk: {S: $pk}, sk: {S: $sk}}')")" ||
    fail "cannot read the registry record of the robot of certificate $id"
  jq -e --arg id "$id" --arg thing "$thing" '
    .Item.status.S == "ACTIVE" and
    .Item.thingName.S == $thing and
    ([.Item.certificates.L[]?.M.certificateId.S] | index($id) != null)' <<<"$record" >/dev/null ||
    fail "ACTIVE certificate $id has no ACTIVE registry record of its robot that lists it"
}

# Walks the certificates. Revoked certificates are the evidence of retirements and are not checked.
check_certificates() {
  local certificates inactive id arn active=0
  certificates="$(aws iot list-certificates --output json)" || fail "cannot list the IoT certificates"
  inactive="$(jq '[.certificates[] | select(.status == "INACTIVE")] | length' <<<"$certificates")"
  if [ "$inactive" -gt 0 ]; then
    warn "$inactive INACTIVE certificate(s): they carry no rights; list them with aws iot list-certificates (docs/security/RUNBOOK_ROBOTS.md)"
  fi
  while IFS=$'\t' read -r id arn; do
    check_active_certificate "$id" "$arn"
    active=$((active + 1))
  done < <(jq -r '.certificates[] | select(.status == "ACTIVE") | [.certificateId, .certificateArn] | @tsv' <<<"$certificates")
  echo "smoke-iot: $active ACTIVE certificate(s) checked"
}

main() {
  require_tool aws
  require_tool jq
  require_tool terraform
  read_outputs
  check_logging
  check_rules
  check_policies
  check_certificates
  echo "smoke-iot: OK (v2 logging at ERROR, four rules enabled, robot policy inventory, certificate inventory)"
}

main "$@"
