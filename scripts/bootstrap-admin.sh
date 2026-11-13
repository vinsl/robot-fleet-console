#!/usr/bin/env bash
# Creates a console account in the operator user pool, or adds an existing account to a group.
# The temporary password is generated here and sent to Cognito in a JSON document on stdin, so it never
# reaches a process list. It is printed once to the terminal and written to no file and no log
# (THREAT_MODEL T36, R58). An existing account keeps its password unless RESET=1 asks for a new temporary
# one, and it only gains the requested group: this script never removes a membership (T37).
#
# Usage:
#   bootstrap-admin.sh EMAIL                  # creates an Admin account (ROLE defaults to Admin for a new account)
#   ROLE=Operator bootstrap-admin.sh EMAIL    # Operator or Viewer; an existing account needs ROLE set explicitly
#   RESET=1 bootstrap-admin.sh EMAIL          # issues a new temporary password for an existing account
#
# Needs an IAM Identity Center session (aws sso login) allowed to call the Cognito admin actions on the pool.
# Exit status: 0 done, 1 refused or failed, 2 usage error.

set -euo pipefail

readonly STACK_DIR="infra/envs/demo"
readonly EMAIL_PATTERN='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
readonly POOL_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+_[A-Za-z0-9]+$'
readonly REGION_PATTERN='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
readonly ROLE_PATTERN='^(Admin|Operator|Viewer)$'
# Cognito limits a username to 128 characters.
readonly MAX_EMAIL_LENGTH=128

# Prints the usage on stderr and exits 2.
usage() {
  cat >&2 <<'EOF'
Usage:
  bootstrap-admin.sh EMAIL                  creates an Admin account (or ensures its group)
  ROLE=Operator|Viewer bootstrap-admin.sh EMAIL
  RESET=1 bootstrap-admin.sh EMAIL          issues a new temporary password for an existing account
EOF
  exit 2
}

# Prints a message on stderr and exits 1. Messages never contain the password, the email or an account id.
die() {
  echo "bootstrap-admin: $1" >&2
  exit 1
}

# Prints the AWS error code of a failed CLI call (for example UserNotFoundException), never its message.
aws_error_code() {
  local code
  code="$(sed -n 's/.*An error occurred (\([A-Za-z]*\)).*/\1/p' <<<"$1" | head -n 1)"
  echo "${code:-unknown error}"
}

# Prints a 28-character temporary password: 144 random bits from openssl, plus a fixed suffix that meets the
# pool policy (upper case, lower case, digit and symbol). Base64 characters are all allowed by Cognito.
new_temporary_password() {
  local random
  random="$(openssl rand -base64 18)"
  printf '%s%s' "$random" 'Aa1!'
}

# Runs an AWS CLI command whose JSON input document arrives on stdin. AWS CLI v2.39 rejects file:///dev/stdin and
# /dev/fd paths as invalid JSON, so the document goes through a file in a private directory (mode 700, file mode 600)
# that is removed before returning. It never reaches argv, so a process list does not show it.
aws_with_json_input() {
  local dir status=0
  dir="$(umask 077 && mktemp -d)"
  cat >"$dir/input.json"
  aws "$@" --cli-input-json "file://$dir/input.json" || status=$?
  rm -rf "$dir"
  return "$status"
}

# Creates the account with the temporary password and no invitation message, then sets its group.
# Every value is validated before this call, so the JSON document needs no escaping.
create_account() {
  local pool="$1" email="$2" password="$3"
  printf '{"UserPoolId":"%s","Username":"%s","UserAttributes":[{"Name":"email","Value":"%s"},{"Name":"email_verified","Value":"true"}],"TemporaryPassword":"%s","MessageAction":"SUPPRESS"}' \
    "$pool" "$email" "$email" "$password" |
    aws_with_json_input cognito-idp admin-create-user >/dev/null
}

# Sets a temporary password on an existing account. Permanent stays false, so the user must change it at sign-in.
set_temporary_password() {
  local pool="$1" email="$2" password="$3"
  printf '{"UserPoolId":"%s","Username":"%s","Password":"%s","Permanent":false}' \
    "$pool" "$email" "$password" |
    aws_with_json_input cognito-idp admin-set-user-password
}

# Signs the account out of every session and revokes its refresh tokens. RESET=1 calls it after a new temporary
# password, so that a session opened with the previous password cannot outlive the reset (THREAT_MODEL T36).
revoke_sessions() {
  local pool="$1" email="$2"
  aws cognito-idp admin-user-global-sign-out --user-pool-id "$pool" --username "$email" >/dev/null
}

# Adds the account to the group. Cognito accepts a repeated call, so a rerun after a failure is safe.
ensure_group() {
  local pool="$1" email="$2" role="$3"
  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$pool" --username "$email" --group-name "$role" >/dev/null
}

# Entry point. Validates the arguments, checks the session and the stack, then creates or updates the account.
main() {
  if [[ $# -ne 1 ]]; then
    usage
  fi
  local email="$1"
  local role="${ROLE:-}"
  local reset="${RESET:-0}"

  if [[ ! "$email" =~ $EMAIL_PATTERN ]] || ((${#email} > MAX_EMAIL_LENGTH)); then
    echo "bootstrap-admin: the email is not a valid address" >&2
    exit 2
  fi
  if [[ -n "$role" && ! "$role" =~ $ROLE_PATTERN ]]; then
    echo "bootstrap-admin: ROLE must be Admin, Operator or Viewer" >&2
    exit 2
  fi
  if [[ "$reset" != 0 && "$reset" != 1 ]]; then
    echo "bootstrap-admin: RESET must be 0 or 1" >&2
    exit 2
  fi

  local tool
  for tool in aws openssl terraform; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required; see .devcontainer/post-create.sh"
  done

  # Relative paths below (the Terraform root) need the repository root, whatever the caller's directory.
  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS session; run 'aws sso login' first"

  local pool region
  pool="$(terraform -chdir="$STACK_DIR" output -raw user_pool_id 2>/dev/null)" ||
    die "the user pool id is not in the Terraform outputs; deploy the stack first"
  region="$(terraform -chdir="$STACK_DIR" output -raw region 2>/dev/null)" ||
    die "the region is not in the Terraform outputs; deploy the stack first"
  if [[ ! "$pool" =~ $POOL_PATTERN || ! "$region" =~ $REGION_PATTERN ]]; then
    die "the Terraform outputs hold an unexpected pool id or region"
  fi
  export AWS_REGION="$region"

  local lookup_error password
  if lookup_error="$(aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$email" 2>&1 >/dev/null)"; then
    if [[ -z "$role" ]]; then
      echo "bootstrap-admin: the account exists; set ROLE=Admin, Operator or Viewer to ensure its group" >&2
      exit 2
    fi
    ensure_group "$pool" "$email" "$role" || die "the account exists but its group could not be set; rerun the same command"
    if [[ "$reset" != 1 ]]; then
      echo "The account already exists: its $role group is ensured and its password is unchanged." >&2
      echo "Run with RESET=1 to issue a new temporary password." >&2
      exit 0
    fi
    password="$(new_temporary_password)"
    set_temporary_password "$pool" "$email" "$password" ||
      die "the temporary password could not be set; rerun with RESET=1"
    revoke_sessions "$pool" "$email" ||
      die "the temporary password is set but the sessions could not be signed out; rerun with RESET=1"
  else
    local code
    code="$(aws_error_code "$lookup_error")"
    [[ "$code" == UserNotFoundException ]] || die "cannot read the user pool ($code)"
    role="${role:-Admin}"
    password="$(new_temporary_password)"
    create_account "$pool" "$email" "$password" || die "the account could not be created"
    ensure_group "$pool" "$email" "$role" ||
      die "the account was created but its group could not be set; rerun the same command, it adds the group without a new password"
  fi

  echo "Temporary password for the $role account, shown once and stored nowhere:"
  echo "$password"
  echo "The user signs in, sets a new password and enrols an authenticator app. The temporary password expires after one day."
}

main "$@"
