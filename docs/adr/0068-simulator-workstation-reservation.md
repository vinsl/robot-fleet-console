# ADR 0068 — Simulator workstation reservation

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-SIM-1, FR-SIM-2
- Implemented in: `agent/src/fleet_agent/sim/stations.py`, `agent/src/fleet_agent/sim/missions.py`,
  `agent/src/fleet_agent/sim/fleet.py`, `agent/tests/sim/test_stations.py`

## Context

Each simulated robot picked its pickup and drop stations at random, without knowing what the others did. On the live
demo, ten robots piled up on the same workstations, which made the map unreadable and showed robots "working" on a
bay that another robot already held.

## Decision

A `StationRegistry`, shared by all robots of one simulator process, records which robot holds which workstation. A
robot reserves its pickup and its drop together (all or nothing) before a mission is assigned, choosing among the free
stations with the seeded random source, so each robot's own random stream is seeded (the fleet outcome still depends on how the robots' ticks interleave). With fewer than two free
stations the robot stays idle and retries on the next tick. A robot keeps its stations while it is blocked or paused,
and releases them when the mission ends (completed, aborted or e-stopped), when the robot halts or stops, and when its
task fails. A robot starts working only at stations it holds, and two robots never hold the same one.

## Alternatives considered

| Option                                      | Pros                              | Cons                                                                 | Why not                                                  |
| ------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| Keep random picks                           | No code                           | Robots pile up; the demo looks wrong                                 | Visible defect in the demo scenario                      |
| Central scheduler assigning missions        | Global optimum, queues            | A new component with its own state, far beyond the demo's need       | Out of scope for the time available                      |
| Collision avoidance between robots on paths | Robots never overlap while moving | Multi-agent path planning; deadlocks in corridors without priorities | A simple stop-and-resume rule may come later, as a bonus |

## Consequences

- The registry is in memory and per process: two simulator processes would not see each other's reservations. The
  demo runs one process.
- Mission end releases on the next driver tick, so a station can stay held for one tick after the work ends.
- `AgentSnapshot` gains `mission_id`, so the driver can see that a mission was aborted.
- Robots can still overlap while they move; occupancy of a station is not drawn in the console.
