# shellcheck shell=bash
# Sourced by scripts/e2e-setup.sh and scripts/e2e-teardown.sh: process helpers for the simulator of one e2e run.
#
# A pid alone does not identify a process: a pid recorded in the state file can be reused by another process after a
# crash. The start time (field 22 of /proc/PID/stat, in clock ticks since boot) is recorded with the pid, and a signal is
# sent only when both still match. The simulator runs in its own session and process group, so the group is signalled
# and its children (uv starts the agent in a child process) stop with it.
#
# Usage: . scripts/e2e-process.sh; is_same_process PID START && stop_group PID

# Prints the start time of a process in clock ticks, or fails when the process has no entry in /proc.
process_start_time() {
  local stat rest
  local -a fields
  # A failed read means the process ended after the check: that is not a start time.
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  # The command name is in parentheses and may hold spaces: the fields start after the last closing parenthesis. The
  # first field after it is field 3 (the state), so field 22 is the element at index 19.
  rest="${stat##*) }"
  read -r -a fields <<<"$rest"
  [[ -n "${fields[19]:-}" ]] || return 1
  printf '%s\n' "${fields[19]}"
}

# Tells whether a process exists and is not a zombie: a zombie has exited and only waits to be reaped.
process_alive() {
  local stat rest state
  # A failed read means the process has no entry any more, which is the same as not alive.
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${stat##*) }"
  state="${rest%% *}"
  [[ "$state" != Z ]]
}

# Tells whether PID is still the process that started at START. Both must be given: an empty start time never matches.
is_same_process() {
  local pid="$1" start="$2" current
  [[ -n "$start" ]] || return 1
  current="$(process_start_time "$pid")" || return 1
  [[ "$current" == "$start" ]] && process_alive "$pid"
}

# Stops the process group led by PID: SIGTERM, up to ten seconds for the leader to exit, then SIGKILL to the group so that
# no child survives. Only call it after is_same_process. Returns 0 when the leader has stopped, 1 otherwise.
stop_group() {
  local pid="$1" i
  kill -TERM -- "-$pid" 2>/dev/null || true
  for ((i = 0; i < 10; i++)); do
    if ! process_alive "$pid"; then
      break
    fi
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  ! process_alive "$pid"
}
