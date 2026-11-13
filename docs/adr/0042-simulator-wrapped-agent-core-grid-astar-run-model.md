# ADR 0042 — Simulator: wrapped agent core, grid A*, run model

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-6 (missions), FR-ROB-7 (faults, simulated only), FR-SITE-3 (no-go zones and obstacles), FR-DEMO-1 (sim side), NFR-COST-2 (no compute in AWS for the simulator), NFR-REL-1
- Threats: T20 (a real robot is never driven or faulted by the simulator hooks), R42 (simulated private keys on one host)
- Supersedes nothing. Builds on ADR 0034 (agent core) and ADR 0043 (protocol schemas, which carry the site map contract).

## Context

The demo needs ten to twenty robots on a warehouse map, moving around racks and not through them, taking missions and
raising faults, while the console sees exactly what it would see from a real robot. Running the simulator in AWS would
cost compute and break the NFR-COST-2 rule, so it runs on a machine the operator owns. A second implementation of the
robot's state machine, safety rules and protocol would drift from the real one, so the simulator must drive the same
core. The robot core already exposes a navigator port and simulator-only calls (ADR 0034 and the M5 core hooks), so the
open questions are the path planner, the run model and what a simulated robot may do that a real one may not.

## Decision

The simulator is the production agent: one `AgentCore` and one transport per robot, in one asyncio process, with
`run_agent` and `RunControls` as the only seam. Three hooks are plugged in: a grid navigator (A* on a 0.25 m occupancy
grid inflated by the 0.4 m robot radius, with a route book of every charger and station pair planned at start and an
on-demand plan in a worker thread for any other start), a mission driver and a fault injector, both of which call only the
simulator-only methods of the core. The run is single-instance (a `flock` on `$XDG_STATE_HOME/fleet/sim.lock`), stops
after two hours by default, and runs on the operator's VM, one kit per robot under `~/.fleet/robots/sim-NN/`.

Acceleration ramp. The core's straight-line motion now ramps at 0.8 m/s² up to the cruise speed and brakes so that it
stops on the target (`next_speed` in `core/motion.py`). The same change applies to a real robot's straight-line motion,
because the ramp lives in the shared motion step, not in the simulator. A real robot therefore accelerates and brakes
differently from before the simulator existed. Stopping states (PAUSED, ESTOP, BLOCKED) still zero the speed on the next
tick, so the safety behaviour is unchanged.

## Alternatives considered

| Option                                                            | Pros                                  | Cons                                                                                                               | Why not                                                           |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Separate simulator publishing raw MQTT                            | Independent of the core               | Duplicates the state machine, the lock, the deadman and the protocol; drift is the first bug to appear             | SPEC 4.2 requires the same code path                              |
| Simulator in Lambda or Fargate                                    | No machine to run                     | Compute cost for an idle demo; violates NFR-COST-2                                                                 | Cost and the always-on requirement                                |
| Visibility graph for planning                                     | Shortest paths                        | More code for the same result at this scale                                                                        | A* on a grid is simpler to test with a raw-grid property test     |
| One process per robot                                             | Crash isolation                       | Twenty processes to supervise; more memory and connections                                                         | The core already halts one robot at a time through the fault gate |
| Real robot runs missions and the planner (`run --map --missions`) | One code path for missions and routes | The core refuses assignment, and `run_agent` refuses the hooks, on a real kit (T20); lifting that is a core change | Not done in M5; open question for the owner                       |

## Consequences

- The console sees the same messages, state transitions and alerts from a simulated robot as from a real one; the
  simulated flag in the kit and in the registry is the only difference, and the console trusts the registry flag.
- Planning cost is paid once at start (about four seconds for the sample map, in a worker thread), then a route is a
  lookup. An off-stop start plans in the background and holds position until the plan is ready, or gives up after three
  seconds and holds for good, logged once.
- A route that cannot be planned is not retried. A robot that cannot reach its destination stays in MOVING with zero
  speed. The core has no abort method, so the driver cannot return the robot to base: a known limit, written in the runbook.
- The fault injector resumes only the blocks it caused, after a random delay. A block an operator raises from the
  console during that window is resumed early. The injector cannot tell the two apart from the state alone.
- The mission driver reads the charge through a read-only accessor on the core (`battery_percent`), because the snapshot
  the operator sees does not carry it. The accessor changes no state.
- Cost: no AWS compute for the simulator. Traffic is what the robots send, as estimated in the M5 design (section 12).
- Security: the simulator refuses a kit that is not simulated, a kit for another site, and a second instance on the same
  host. Its private keys live on the host that runs it and nowhere else (R42, RUNBOOK_SIM).
