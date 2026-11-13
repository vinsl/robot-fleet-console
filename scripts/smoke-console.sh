#!/usr/bin/env bash
# Post-deploy checks of the console and of its HTTP API, run by make smoke when CONSOLE_URL is set:
# the security headers of ADR 0046, the SPA deep link, the private bucket, and the API routes of ADR 0047.
# Only public requests are made: no token, no credential, and no body is sent or printed.
#
# Usage: smoke-console.sh https://CONSOLE_HOST
# Exit status: 0 all checks passed, 1 a check failed or a value is missing.

set -euo pipefail

readonly STACK_DIR="infra/envs/demo"
readonly CONSOLE_PATTERN='^https://[a-z0-9.-]+$'
readonly BUCKET_PATTERN='^mfc-demo-console-[a-z0-9-]+$'
readonly REGION_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
readonly API_PATTERN='^https://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$'
readonly CSP_REQUIRED="frame-ancestors 'none'"
# The exact key set of the runtime configuration (ADR 0048), with every value a string.
readonly CONFIG_SHAPE='keys == ["apiUrl","identityPoolId","region","userPoolClientId","userPoolId","wsUrl"] and all(.[]; type == "string")'
readonly TIMEOUT_SECONDS=15

# Counts the failed checks, so that every check runs and the report lists all of them.
failures=0

# Prints a failed check on stderr and counts it.
fail() {
  echo "smoke-console: FAIL $1" >&2
  failures=$((failures + 1))
}

# Prints the status code of a response, from the status line of a header dump.
status_of() {
  awk 'NR == 1 { print $2 }' <<<"$1"
}

# Prints the value of a response header (case-insensitive), or nothing when the header is absent.
header_of() {
  local name="$1" headers="$2"
  grep -i "^${name}:" <<<"$headers" | tail -n 1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//' || true
}

# Prints the status line and the headers of a request, and discards the body.
headers_of() {
  curl -sS --max-time "$TIMEOUT_SECONDS" -o /dev/null -D - "$@"
}

# Reads a Terraform output of the stack, refusing when it is absent or has an unexpected format.
stack_output() {
  local name="$1" pattern="$2" value
  value="$(terraform -chdir="$STACK_DIR" output -raw "$name" 2>/dev/null)" || {
    echo "smoke-console: the Terraform output $name is unavailable; deploy the stack first" >&2
    exit 1
  }
  if [[ ! "$value" =~ $pattern ]]; then
    echo "smoke-console: the Terraform output $name has an unexpected format" >&2
    exit 1
  fi
  echo "$value"
}

# Checks one response: its status code and, when given, a header value that must match a pattern.
expect_status() {
  local label="$1" expected="$2" headers="$3"
  local actual
  actual="$(status_of "$headers")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label: status $actual, expected $expected"
  fi
}

# Entry point: console headers, SPA deep link, private bucket, then the API routes.
main() {
  if [[ $# -ne 1 ]]; then
    echo "usage: smoke-console.sh https://CONSOLE_HOST" >&2
    exit 1
  fi
  local console="${1%/}"
  if [[ ! "$console" =~ $CONSOLE_PATTERN ]]; then
    echo "smoke-console: CONSOLE_URL must be an https:// host name" >&2
    exit 1
  fi
  local tool
  for tool in curl jq terraform awk; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "smoke-console: $tool is required" >&2
      exit 1
    }
  done

  local root_headers
  root_headers="$(headers_of "$console/")" || {
    echo "smoke-console: the console does not answer" >&2
    exit 1
  }
  expect_status "GET /" 200 "$root_headers"

  local csp hsts nosniff frame referrer
  csp="$(header_of content-security-policy "$root_headers")"
  if [[ "$csp" != *"$CSP_REQUIRED"* ]] || [[ "$csp" == *unsafe-inline* ]] || [[ "$csp" == *unsafe-eval* ]]; then
    fail "content-security-policy lacks frame-ancestors 'none' or allows inline code"
  fi
  hsts="$(header_of strict-transport-security "$root_headers")"
  [[ "$hsts" == max-age=* ]] || fail "strict-transport-security is missing"
  nosniff="$(header_of x-content-type-options "$root_headers")"
  [[ "$nosniff" == nosniff ]] || fail "x-content-type-options is not nosniff"
  frame="$(header_of x-frame-options "$root_headers")"
  [[ "$frame" == DENY ]] || fail "x-frame-options is not DENY"
  referrer="$(header_of referrer-policy "$root_headers")"
  [[ "$referrer" == no-referrer ]] || fail "referrer-policy is not no-referrer"

  # A deep link must return the SPA shell, so that the router handles the path.
  local deep_headers deep_type
  deep_headers="$(headers_of "$console/alerts")" || fail "GET /alerts does not answer"
  expect_status "GET /alerts" 200 "${deep_headers:-}"
  deep_type="$(header_of content-type "${deep_headers:-}")"
  [[ "$deep_type" == text/html* ]] || fail "GET /alerts is not text/html"

  # The runtime configuration is public, but it must exist with exactly the keys of ADR 0048 for the console to boot.
  local config_body
  config_body="$(curl -sS --max-time "$TIMEOUT_SECONDS" "$console/config.json")" || fail "GET /config.json does not answer"
  jq -e "$CONFIG_SHAPE" <<<"${config_body:-null}" >/dev/null 2>&1 || fail "GET /config.json is not the runtime configuration"

  # The bucket is private: a direct request must be refused, whatever the object.
  local bucket region bucket_headers
  bucket="$(stack_output console_bucket_name "$BUCKET_PATTERN")"
  region="$(stack_output region "$REGION_PATTERN")"
  bucket_headers="$(headers_of "https://$bucket.s3.$region.amazonaws.com/index.html")" || true
  expect_status "direct bucket request" 403 "${bucket_headers:-}"

  # The API: health answers without a token, /me refuses a missing or invalid token, and CORS denies other origins.
  local api health me me_garbage preflight
  api="$(stack_output api_endpoint "$API_PATTERN")"
  health="$(headers_of "$api/health")" || fail "GET /health does not answer"
  expect_status "GET /health" 200 "${health:-}"
  me="$(headers_of "$api/me")" || fail "GET /me does not answer"
  expect_status "GET /me without token" 401 "${me:-}"
  me_garbage="$(headers_of -H 'Authorization: Bearer not-a-token' "$api/me")" || fail "GET /me with a garbage token does not answer"
  expect_status "GET /me with a garbage token" 401 "${me_garbage:-}"
  preflight="$(headers_of -X OPTIONS -H 'Origin: https://evil.example' \
    -H 'Access-Control-Request-Method: GET' "$api/me")" || fail "the CORS preflight does not answer"
  if [[ -n "$(header_of access-control-allow-origin "${preflight:-}")" ]]; then
    fail "the API allows a foreign origin in CORS"
  fi

  if ((failures > 0)); then
    echo "smoke-console: $failures check(s) failed" >&2
    exit 1
  fi
  echo "smoke-console: OK (headers, deep link, runtime config, private bucket, API routes and CORS)"
}

main "$@"
