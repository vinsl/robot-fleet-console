# shellcheck shell=bash
# Sourced by the e2e scripts and by the Makefile: defines e2e_state_dir, the one place that decides where the
# ephemeral e2e state lives (ADR 0069). It holds the temporary password, the password and the robot kit path, so
# it is a private directory and is removed by make e2e-teardown.
#
# Usage: state_dir="$(. scripts/e2e-state-dir.sh && e2e_state_dir)" || exit 1

# Prints the state directory on stdout, creating it with mode 700 when it is missing. Refuses an existing directory
# that is a symbolic link, belongs to another user, or is not mode 700: the default location is a fixed name under
# a shared temporary directory, so an attacker who creates it first must not get the state. Errors go to stderr.
e2e_state_dir() {
  local base="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  local dir="$base/mfc-e2e" mode owner
  if [[ -L "$dir" ]]; then
    echo "e2e: the state directory is a symbolic link; remove it and retry" >&2
    return 1
  fi
  if [[ ! -e "$dir" ]]; then
    mkdir -m 700 -- "$dir" || {
      echo "e2e: cannot create the state directory" >&2
      return 1
    }
  fi
  if [[ ! -d "$dir" ]]; then
    echo "e2e: the state path is not a directory" >&2
    return 1
  fi
  mode="$(stat -c '%a' -- "$dir")"
  owner="$(stat -c '%u' -- "$dir")"
  if [[ "$mode" != 700 || "$owner" != "$(id -u)" ]]; then
    echo "e2e: the state directory must be owned by the current user with mode 700" >&2
    return 1
  fi
  printf '%s\n' "$dir"
}
