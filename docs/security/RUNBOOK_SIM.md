# Runbook: the simulated fleet

Owner: the repository owner. The simulator runs on a machine they control (the second VM, or the Kali VM as a fallback), next to
nothing else that holds robot keys. The design is in ADR 0042 (simulator), ADR 0029 (provisioning), ADR 0039 (ingest
consumer toggle) and the M5 design, sections 7 and 9.4 to 9.5. Threats: T20 (simulated only), R38 (the consumer
toggle), R42 (simulated private keys on one host).

Placeholders in angle brackets are filled from your session. Never paste a kit, a private key, an account id or a
lock file's contents into a ticket, a chat or a screenshot.

## 0. Prerequisites (on the machine that runs the simulator)

- Python 3.12 and `uv`, with the repository checked out and `make install` run once.
- AWS CLI v2 and `jq` for `robots-admin.sh`, and `flock` from util-linux (every current Linux has it).
- `aws sso login --profile <profile>` before the first command of a session. Run `aws sso logout` when you finish.
- The machine has a user state directory (`$XDG_STATE_HOME`, or `~/.local/state`). The simulator creates `fleet/` in it
  with owner-only permissions.

## 1. Register the simulated robots (once, then only when the count changes)

```bash
scripts/sim-provision.sh 20 --site-id paris-01
```

This runs `robots-admin.sh register` for `sim-01` to `sim-20`, with `--simulated true`, using your own session. A kit that
already exists is skipped, and the script stops at the first failed registration, so it can be run again. The kits are
written under `~/.fleet/robots/sim-NN/` (directory 0700, file 0600). Each kit is bound to its own topics by the IoT
policy. Registration is irreversible in practice: an identifier is never reused (ADR 0029), so register only the
identifiers the demo needs. Keep the kits on this machine only.

## 2. Run a session

```bash
make demo-start            # once: enable the ingest consumer, so that live data reaches the console
make sim N=9               # 9 simulated robots, auto-stop after 2 h
make demo-stop             # stop the simulator, then disable the consumer
```

`make sim N=9` checks that `N` is between 1 and 20 (exit 2 otherwise) and that every kit exists (exit 2 and the
`sim-provision.sh` command otherwise), then starts `fleet-agent sim` on the site's active map (below). The defaults are
`SIM_SITE_ID=paris-01`, `SIM_FAULT_RATE=6` faults per robot per hour, `SIM_MAX_RUNTIME_S=7200`, `SIM_SEED=1`, and the
map `SIM_MAP`. `sim.sh` checks each value before the agent runs (exit 2 for a malformed or out-of-range one), and passes
them as `--option=value`. The runtime is 1 to 14400 seconds: four hours is the longest run, and no option removes the
auto-stop (THREAT_MODEL T25).

**Map.** With `SIM_MAP` unset, `sim.sh` runs `scripts/fetch-active-map.sh SITE_ID OUTPUT` with the operator's own
session, then runs on the copy in `${XDG_CACHE_HOME:-~/.cache}/fleet/active-map-SITE_ID.geojson` (owner-only). The
fetch reads the site profile and its `activeVersion` from the fleet table, then the object version the console
validated, and refuses a map whose SHA-256 differs from the one recorded at validation. The operator's role must be
allowed to read the fleet table and the site-maps bucket. When the fetch fails, the run stops with an error: it never
falls back silently to a map the console does not show. `SIM_MAP=sample` selects the protocol's sample map without any
AWS call; any other value names a GeoJSON file. The simulator refuses a map larger than 200 m across.

The reminder printed by `make sim` when the consumer is off is read-only. It is skipped without AWS credentials.

`make demo-stop` runs `scripts/sim-stop.sh` first, then `scripts/demo-consumer.sh disable`. The consumer is disabled even
when the simulator does not stop, and the target exits with the worse of the two statuses (the test
`test_demo_stop_disables_the_consumer_even_when_the_simulator_fails` checks it). `KEEP_CONSUMER=1 make demo-stop`
stops only the local robots, leaves the consumer on, and exits with the stop's status.

R38: Terraform ignores the mapping's enabled flag, so a deploy does not turn the consumer back on, and a forgotten
`make demo-start` leaves the console without live data. A consumer left disabled loses at most one hour of telemetry
(the SQS retention); nothing is written.

## 3. The command line

```bash
uv run --project agent fleet-agent sim --help
```

| Option                  | Default           | Meaning                                                                             |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `--count`               | (required)        | robots, 1 to 20                                                                     |
| `--site-id`             | (required)        | the site every kit must name                                                        |
| `--map`                 | (required)        | the site map, GeoJSON in the local metric frame (the protocol's contract, ADR 0043) |
| `--prefix`              | `sim`             | identifier prefix, identifiers are `<prefix>-01` to `<prefix>-NN`                   |
| `--seed`                | `1`               | same seed, same missions and faults                                                 |
| `--fault-rate-per-hour` | `6`               | mean random faults per robot per hour; `0` disables them                            |
| `--max-runtime-seconds` | `7200`            | auto-stop, from 1 to 14400 seconds (four hours, the cap)                            |
| `--stagger-ms`          | `250`             | gap between two robot starts, so the broker is not flooded                          |
| `--kit-root`            | `~/.fleet/robots` | where the kits are                                                                  |

Exit codes: `0` every robot ended cleanly or after a forced stop; `70` a robot halted (the highest other code is
reported); `75` another simulator already runs on this host, nothing connected; `78` the run cannot start (a bad
parameter, an unreadable or refused map, a station the obstacles block or no route reaches, a missing or real kit, a kit
for another site, no room for the robots); `130` a second stop signal forced the exit.

## 4. Stop, and what a stop means

- `make demo-stop` (or `scripts/sim-stop.sh`) sends `SIGTERM` to the process that holds the lock, then waits up to 30 s.
  Each robot stops its motion, publishes `GOING_OFFLINE`, and disconnects. The console then shows the robots as offline
  without an alert, because the goodbye was clean.
- A second `SIGTERM` (or `Ctrl-C` twice) forces the exit with code 130, without waiting for the goodbye. The console then
  raises an OFFLINE alert for each robot, as for a lost link.
- `sim-stop.sh` never sends `SIGKILL`. If the process is still there after 30 s, it says so and exits 1: look at it, then
  decide. It refuses to signal a process whose command line does not name the simulator.
- The run stops by itself at its deadline, with a warning 300 s before it (`sim.deadline_soon`).
- A robot still in its stagger when a stop arrives never connects, and it ends with exit 0.

## 5. Logs and what to look for

Standard output carries one JSON line per event, with the `fleet_agent.sim` logger and the events `sim.started`,
`sim.stop_requested`, `sim.deadline_soon`, `sim.route_unreachable`, `sim.robot_halted` and `sim.robot_failed`, plus the
agent's own `agent.*` events for each robot. `sim.robot_failed` names the exception class only, never its message.
A halted robot (`sim.robot_halted`, exit 70) is not restarted: its core is stopped on purpose. Read its `agent.halted`
line, fix the cause, and restart the run. The other robots carry on until the run stops.

## 6. Known limits (say them in the demo, do not hide them)

- A route that cannot be planned, or a plan that takes more than three seconds, holds the robot in MOVING at zero speed
  for the rest of that trip. The driver cannot abort the mission: the core has no abort method. The operator sees a
  robot that does not move, and the log line `sim.route_unreachable`.
- The fault injector resumes only the blocks it caused, 15 to 45 s later. A block an operator raises from the console
  during that window is resumed early, because the core does not say what caused a block. Operator blocks outside the
  window wait for the console RESUME.
- Robots do not avoid each other. The simulator has no collision model, so two robots can share a cell.
- The site map is limited to 200 m across (the simulator grid). The protocol allows 1 000 m.
- The per-robot connect-slow log (`sim.robot_connect_slow`) is not written yet; the stagger is the protection.
- `run --map --missions` for a real robot is not in this release: the core and `run_agent` refuse simulator hooks on a
  real kit (T20). That is a decision for the owner, see ADR 0042.

## 7. Security notes

- The simulator refuses any kit that does not say `simulated: true`, and any kit for another site. There is no setting
  that changes it. The console trusts the registry flag, never the robot's own BOOT event.
- One simulator per host, enforced by the lock. Two processes would connect the same client identifiers, and the broker
  would drop both in turn.
- The kits never leave the machine that holds them. Revoke a robot in the registry and remove its kit directory when you
  retire it (`robots-admin.sh retire`), so no stale key stays on the host (R42).
- The simulator does not log tokens, keys or payloads. Its logs carry identifiers, counts and exit codes.

## 8. Troubleshooting

| Symptom                                                    | Cause and action                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `make sim` exits 2 with missing kits                       | Run `scripts/sim-provision.sh N --site-id paris-01` on this machine.                                                      |
| `sim` stops with `the active map ... could not be fetched` | Run `scripts/fetch-active-map.sh paris-01 /tmp/x.geojson` to see why. Without an active map, activate one in the console. |
| `sim.already_running`, exit 75                             | Another simulator holds the lock. `scripts/sim-stop.sh` stops it.                                                         |
| `sim.refused` with `KIT_REFUSED` or `KIT_NOT_SIMULATED`    | The named kit is missing, damaged, real or for another site. Re-register it or fix the kit directory.                     |
| `sim.refused` with `STOP_BLOCKED` or `UNREACHABLE_STOP`    | The map puts a station inside an obstacle or walls it in. Fix the map (the console export, M7).                           |
| `demo-consumer: no AWS credentials`                        | `aws sso login --profile <profile>`, then retry.                                                                          |
| Console shows no live data                                 | `make demo-start`, then check `scripts/demo-consumer.sh status` says `Enabled`.                                           |
| `demo-consumer` says "still Disabling"                     | AWS has not settled the mapping. Wait a minute and run `status` again.                                                    |
