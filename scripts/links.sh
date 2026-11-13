#!/usr/bin/env bash
# Prints the three read-only links of the demo: the console, the Cognito user list and the IoT thing hub.
# They are built from the Terraform outputs of the stack, read with the operator's own AWS session.
#
# Usage: scripts/links.sh
# Exit status: 0 printed, 1 when a tool is missing or the stack outputs cannot be read.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT

if ! command -v uv >/dev/null 2>&1; then
  printf 'links: uv is required; see .devcontainer/post-create.sh\n' >&2
  exit 1
fi

exec uv run --project "${ROOT}/agent" python -m fleet_agent.demo_ui links
