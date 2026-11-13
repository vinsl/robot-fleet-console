#!/usr/bin/env bash
# Repository check of the IoT identity (THREAT_MODEL R20): exactly one aws_iot_policy is declared in
# infra/, so that every robot certificate can only receive the one policy that binds its topics.
# A second policy would be a second identity model, and a policy created by hand is caught by the
# live inventory of make smoke. Run by make check-tf.

set -euo pipefail
umask 077

# Assigned before it is made readonly: `readonly x="$(...)"` would hide a failing command (SC2155).
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly expected=1

# Only resource declarations count: a comment or a string that names the type is not a policy.
# grep exits 1 when nothing matches; under pipefail that must not end the script before the message.
matches="$(grep -rEh --include='*.tf' --exclude-dir=.terraform --exclude-dir=.terraform-check \
  '^[[:space:]]*resource[[:space:]]+"aws_iot_policy"[[:space:]]+"' "$repo_root/infra" || true)"
declared=0
if [ -n "$matches" ]; then
  declared="$(printf '%s\n' "$matches" | wc -l)"
  declared="${declared//[[:space:]]/}"
fi

if [ "$declared" -ne "$expected" ]; then
  echo "check-iot-inventory: expected $expected aws_iot_policy resource under infra/, found $declared" >&2
  echo "check-iot-inventory: the robot identity has exactly one IoT policy (THREAT_MODEL R20)" >&2
  exit 1
fi

echo "check-iot-inventory: OK (one aws_iot_policy under infra/)"
