# ADR 0065 — Demo mode flag and three layers for simulated faults

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-DEMO-1, FR-ROB-5, FR-AUTH-1, SEC-API-1, SEC-LOG-1
- Threat: T51, T58
- Implemented in (planned, M9): `services/api/src/domain/control/demo.ts`, `services/api/src/adapters/dynamodb-control-state.ts`
  (`DynamoDbDemoStore`), `packages/protocol/src/control.ts` (`DemoStateSchema`, `DemoUpdateRequestSchema`),
  `apps/console/src/demo/DemoBanner.tsx`, `apps/console/src/robot/FaultInjector.tsx`, `agent/src/fleet_agent/core/agent.py`

## Context

The demo scenario (SPEC 2 minutes, step 3) needs a "robot blocked" alert on demand. FR-DEMO-1 asks for an Admin-only
toggle, a visible banner, fault injection only on robots flagged `simulated: true`, and an audit record. The real robot
is a webcam robot on the same fleet, so a fault sent to it by mistake would be a real stop. T58 is the threat: a fault
reaching a real robot.

## Decision

- **The flag is one item** in the fleet table: `SITE#{site}` / `DEMO`, with `enabled`, `changedBy` and `changedAt`. An
  absent item means disabled.
- **Who can change it.** `GET /sites/{siteId}/demo` is open to every role, so every console can show the banner.
  `PUT /sites/{siteId}/demo` is Admin only. Each `enable` and `disable` is audited (`demo.enable`, `demo.disable`, ADR 0064).
- **Faults use the normal command route.** `SIMULATE_FAULT` goes through `POST .../commands` with the policy of ADR 0062,
  and the fault codes are the four of `FaultCodeSchema`.
- **Three layers, each able to refuse on its own:**
  1. Route policy: Admin only, demo mode on (`demo-mode-off` 409 otherwise), and the registry says `simulated`
     (`not-simulated` 409 otherwise). The cloud refuses before anything is published.
  2. The robot agent rejects `SIMULATE_FAULT` with `NOT_SIMULATED` unless its kit says it is simulated (ADR 0028).
  3. The simulated flag is set when the robot is registered, from the kit. A real robot is never registered as simulated.
- **Banner refresh.** The console reads the flag with a query every 15 s. No WebSocket frame is added for it, so the
  protocol does not change for a banner.

## Alternatives considered

| Option                                   | Pros                                  | Cons                                                                        | Why not                                                                       |
| ---------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Lambda environment variable for the flag | Simple to read                        | A deploy to toggle; no actor and no time on the change                      | The change must name the Admin and the time (FR-DEMO-1, audit)                |
| SSM parameter for the flag               | Simple to read, audited by CloudTrail | A second service in the path of every fault; the actor is not in the record | The fleet table already holds site state and writes the actor with the change |
| `demo.changed` WebSocket frame           | Banner updates at once                | A protocol change for a banner                                              | A 15 s lag on a banner is acceptable                                          |
| A separate fault endpoint                | Clear name                            | A second path with its own policy, audit and replay rules                   | One command path keeps the policy table as the only place to check a fault    |
| Robot-side check only                    | One check                             | The command already left the cloud, and the robot is the last layer         | The cloud refuses first so a wrong target never receives the command          |

## Consequences

- The demo can be left on by an Admin. The banner is permanent while it is on (DESIGN 3.6), and every change is audited.
- Faults are visible in the audit as `command.simulate_fault` with the command id.
- The banner lags by up to 15 s after a change. The fault control itself reads the flag at send time, so the lag does
  not allow a fault while the flag is off.
- The registry flag `simulated` is the only way a robot becomes eligible for faults, so registration must set it
  correctly. The simulator provisioning (`scripts/sim-provision.sh`) sets it, and the registration of a real robot
  (`scripts/robots-admin.sh`) does not.
- T58 is closed by three independent checks, and each has a test (`fault-on-real-robot-409`, `fault-demo-off-409`, and
  the agent test for `NOT_SIMULATED`).
