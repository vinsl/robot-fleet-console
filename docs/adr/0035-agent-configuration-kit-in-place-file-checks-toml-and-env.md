# ADR 0035 — Agent configuration: kit read in place, file mode checks, TOML and environment settings

- Status: accepted
- Date: 2026-11-02
- Requirements: SEC-SEC-1, SEC-ID-1, NFR-OBS-1, T2, T9, T19, T20

## Context

`scripts/robots-admin.sh` writes the registration answer of a robot into `~/.fleet/robots/<robot-id>/register-response.json`
(ADR 0029). That single JSON file holds the certificate, the private key, the root CA and the configuration. It is not a
set of PEM files, so SPEC §4.1 ("paths to cert and key from config") does not describe what exists. The agent must
refuse a kit that other local users can read or swap (T2), and must never print or log key material (T9). SPEC §4.1 also
named `pydantic-settings`. The TOML file's location depends on the robot identifier, which environment-driven settings
sources do not express cleanly, and the TOML file needs the same file checks as the kit.

## Decision

**The kit is read in place, once, and kept in memory.** `load_kit` (`agent/src/fleet_agent/config/kit_file.py`) reads
`register-response.json` from the robot's kit directory, validates it as a successful `RegisterInvokeOk` with the
protocol schema, and cross-checks the robot identifier, the site, the simulated flag and the thing name against the
robot being started. The PEM text is kept as bytes in `TlsMaterial`, whose `repr` is redacted. The key is never copied
to another file. The checks, in order, with the first failure winning:

- The kit root and the robot's kit directory are real directories, owned by the agent's user, with no group or other
  bits (`0700` or narrower). A symlink is refused.
- The kit file is a regular file owned by the agent's user, with no execute bit and no group or other bit (`0600` or
  `0400`). It is opened with `O_NOFOLLOW`, and every check runs on the open descriptor (`fstat`). It is opened with
  `O_NONBLOCK`, so a FIFO is refused rather than waited on.
- The file is at most 64 KiB. It is read at most one byte past that limit, so an oversize file is never loaded.

**Settings are plain pydantic with the standard `tomllib`** (`agent/src/fleet_agent/config/settings.py`). The
precedence is defaults, then `agent.toml` in the kit directory, then `FLEET_*` environment variables, then the command
line. The rules:

- The optional `agent.toml` is read under the same no-symlink, no-FIFO rules, with a size cap of 16 KiB. It may be
  readable by others, but it must not be writable by the group or by others. It cannot set `robot_id` or `kit_root`,
  which locate it.
- An unknown `FLEET_*` variable is refused by name, so a typo cannot leave a setting at its default. An empty
  `FLEET_KIT_ROOT` counts as unset.
- There is no `simulated` setting. A robot is simulated only when its kit says so (T20).
- Errors carry a code and the name of the variable, key or field, never a value. They are raised `from None`, so the
  text of a JSON, TOML or pydantic error, which can quote a key, never reaches the message.

**The runner decisions** (`agent/src/fleet_agent/runtime/runner.py`) are recorded here, because they define what a
stop, a fault or a refusal does to the robot:

- **Fault gate.** Every entry into the core goes through a `FaultGate`: the tick, the listener callbacks
  (`GuardedListener`), the completions of publishes and subscribes (`GuardedTransport`), and the event loop's exception
  handler. An unexpected exception halts the core with its type name as the reason, and logs `agent.fault` with the type
  and the frames only. The message is never logged, since it can quote a topic or a payload. A loop error without an
  exception object is logged under its own name.
- **Exit codes.** `0` for a requested stop. `1` when the isolation probe found a failed check (probe only). `64` for a
  usage error. `70` when the core halted, or when the core, the link or a side service failed to start. `78` when the kit,
  the settings, the transport or the e-stop latch cannot be used, before anything connects. `130` when a second stop
  signal forced the exit.
- **Shutdown order.** `begin_shutdown()`, then `build_goodbye()` (so the goodbye carries the highest sequence number),
  then the `GOING_OFFLINE` publish, with at most 2 s to wait for its acknowledgement. Then the side services stop in
  reverse start order, each within 3 s. Then the gate closes, and the transport disconnects normally with at most 3 s to
  confirm. Once the run has started, a second signal exits 130, after `begin_shutdown()` has run.
- **An e-stop is acted on until the gate closes.** The gate stays open after the goodbye, so an e-stop that arrives
  while the link is up is latched and acknowledged, and connection events and publish completions still reach the core. The core drops every other command while it stops. Accepted residual:
  an announcement the core publishes after the goodbye can follow `GOING_OFFLINE`, for example the `STATE_CHANGED` of an
  e-stop, or a `fault.cleared` when the link comes back during the shutdown. The console must treat an acknowledgement
  that carries state `ESTOP` as authoritative (ADR 0034).
- **Composition root.** `cli.py` parses the command line, builds the operator tools (`tools/`) and calls `run_agent`
  from `runtime.runner`. Only `__main__.py` imports the CLI, so the runner does not depend on it.

## Alternatives considered

| Option                                            | Pros                                                      | Cons                                                                                                         | Why not                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pydantic-settings` 2.16                          | Standard environment sources and prefixes, less code      | The TOML path depends on the robot identifier, and the file would still need the same checks written by hand | Plain pydantic and `tomllib`, with no new dependency (SPEC §4.1 deviation recorded here) |
| Split the kit into `cert.pem` and `key.pem` files | Each file can be checked and passed to tools on its own   | A second copy of the key on disk (T2), and two more files to refuse by mode                                  | One file, read in place, and no copy                                                     |
| A `FLEET_SIMULATED` environment override          | A demo run on a real robot's machine without a second kit | A real robot could be made fault-injectable from the environment (T20)                                       | The flag comes from the kit only                                                         |
| Log and continue after an unexpected exception    | The link stays up                                         | A core in an unknown state keeps moving                                                                      | Halt the core, stop the robot, and exit 70 (ADR 0034)                                    |

## Consequences

- Easier: the kit is one file with one loader, and each refusal has its own code and its own test. A fault in a
  callback stops the robot, whatever the callback was doing.
- Harder: a kit copied to another place must be given mode `0600` by hand. A VirtualBox shared folder is refused, so
  the kit stays on the machine's own disk. The code does not bind a kit to a machine: "register on the machine that runs
  the agent, and never copy a kit" is an operating rule (T2, `docs/security/RUNBOOK_ROBOTS.md`).
- Watch: the key stays in process memory for the whole run, and Python cannot wipe it (R31). `estop-command` and
  `probe-isolation` also load the kit, so they also read the key into memory, although they never use it.
- Operators get a code and the field paths when a kit is refused, never the value. Debugging a refusal starts from the
  code.
- Accepted: the shutdown residual above, and the rule that a stale `estop.latch` survives a restart until it is removed
  by hand (R30 for the write side, ADR 0034).
- Threats: T2 (kit and key), T9 (no value in an error or a log), T19 (the stop through a shutdown and the exit codes),
  T20 (no simulated setting). See `docs/security/THREAT_MODEL.md`.
