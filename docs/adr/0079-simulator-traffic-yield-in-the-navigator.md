# ADR 0079 — Simulator traffic yield in the navigator, not a robot state

- Status: accepted
- Date: 2026-11-04
- Requirements: none (simulator realism, bonus M in `docs/ROADMAP.md`)

## Context

The simulated robots (`make sim`, `make demo`) follow their paths on the site map without looking at each other, so two
robots can drive through the same cell and overlap on the map. The simulator is a visual stand-in for the fleet, used in
the demo and in the screenshots. It is not a safety function, and the real robot agent is not affected.

The robot agent core (`agent/src/fleet_agent/core`) already has a navigator port. When the navigator returns no next
waypoint, the core holds the position, so a robot that has nothing to advance to stays where it is. The state machine
has an obstacle state (`OBSTACLE_DETECTED`, the BLOCKED state of the robot) that raises an alert and needs a RESUME
from an operator.

## Decision

A simulated robot that has to wait for another robot stays in MOVING with speed 0. The simulator's navigator returns no
waypoint, and the core holds the position, as it already does for a navigator that returns nothing.

- `agent/src/fleet_agent/sim/traffic.py` holds a `TrafficBoard`, shared by the simulated robots of one run, and an
  `AvoidingNavigator` that wraps the grid navigator of each robot. The board decides whether a robot may advance: a
  robot waits when another robot is closer than 1 m and in its path. Priority is fixed by the robot id, so the decision
  is deterministic. A standoff longer than 6 s gives one robot a pass for 3 s, which breaks deadlocks.
- The parking area around the charger is not checked, and a stationary robot at a shared dock does not block.
- No change to `core/`, to the state machine, to the protocol or to the console code. The real agent is not touched.

## Alternatives considered

| Option                                 | Pros                                        | Cons                                                                                                          | Why not                                                                                                         |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Send `OBSTACLE_DETECTED` while waiting | The console shows that the robot is blocked | BLOCKED raises an alert and needs a RESUME from an operator; the error-rate KPI counts it; availability drops | The fleet would need an operator for every crossing, and the demo numbers would show faults that are not faults |
| Change the core to add a yield state   | Explicit state in the protocol              | Changes `core/` and the state machine, which are tested and shared with the real robot                        | Too large for a visual simulator, and the real agent would need the same change                                 |
| Do nothing (robots overlap)            | No work                                     | The map shows robots driving through each other, which the demo cannot explain                                | The point of bonus M                                                                                            |

## Consequences

- While waiting, the console shows the robot as MOVING at 0 m/s. The state is the one the core reports, and the
  console has no state for a waiting robot. This is accepted, and the console does not change for it.
- After a standoff of 6 s, one robot passes and may overlap the other for a short time (about 3 s). This is a known
  residual of the simulator. It is not a safety function and must not be described as one.
- With 20 simulators, the robots wait for each other at crossings and in corridors, so the fleet moves more slowly than
  before. This is expected, and the live test noted it.
- The rule is covered by unit tests of `traffic.py` and by a soak test of 20 robots, which checks that no pair is closer
  than 0.5 m outside a pass window and that every robot reaches its goal.
- No security or cost impact: the simulator runs on the simulator machine and sends the same telemetry as before.
