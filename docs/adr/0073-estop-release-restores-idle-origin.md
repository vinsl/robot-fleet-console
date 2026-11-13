# ADR 0073 — E-stop release returns an idle robot to IDLE

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-CMD-4, SPEC §6 (e-stop invariant), T15, T19

## Context

ADR 0028 sends `ESTOP_RELEASE` to `PAUSED` in every case, and SPEC §6 says the same. The rule protects a robot that
was moving or working when the stop came: it must not restart by itself. A robot that was `IDLE` when the e-stop hit
has nothing to resume, so `PAUSED` only adds a step. In the live test the released idle robot stayed `PAUSED`, and the
operator had to send a command to make it usable again. The robot must not forget where it was, and the origin is the
only fact that decides the target.

## Decision

After an e-stop, `ESTOP_RELEASE` goes to `IDLE` when the robot was `IDLE` at the e-stop, and to `PAUSED` otherwise,
including when the origin is unknown after a reboot. It never goes to a motion state.

- The origin is a flag in memory, `estop_from_idle`. The effect `RECORD_ESTOP_ORIGIN` sets it on the `ESTOP` entry
  rows. It is not written to the latch file.
- Two guards decide the release: `ESTOP_FROM_IDLE` and `ESTOP_FROM_OTHER`. `guards_for` computes them from
  `estop_from_idle` and the state `ESTOP`, so exactly one always holds.
- `CLEAR_ESTOP_LATCH` clears the latch. If the clear fails, the release fails and the origin is kept, so a retry takes
  the same branch.
- The stop path that bypasses the table resets the flag to `False`, so a stop without a recorded origin is treated as
  `PAUSED`.
- The release still needs the control lock (ADR 0028) and the Operator role.
- The simulator starts no mission while the lock is held (`agent/src/fleet_agent/sim/missions.py`). A released idle
  simulated robot therefore does not move under a lock that the operator still holds.

## Alternatives considered

| Option                                 | Pros                              | Cons                                                                                       | Why not                                                                                                 |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Persist the origin in the latch record | Survives a reboot                 | Schema change; a stale or forged field could steer the release target                      | The release target must come from the robot's own record of the stop, not from a file a reader can edit |
| Record the origin inside `LATCH_ESTOP` | One effect, one place             | A retried latch write (R30) runs the effect again, from `ESTOP`, and overwrites the origin | The origin must be recorded once, on the entry row                                                      |
| Keep `PAUSED` for every release        | One rule, matches SPEC §6 wording | An idle robot is left `PAUSED` and needs an extra command                                  | Found in the live test; the cost falls on the operator for no safety gain                               |

## Consequences

- An idle robot that is released comes back `IDLE` with no extra command. Any other robot still comes back `PAUSED`.
- A reboot while the robot is latched releases to `PAUSED`. The origin is lost with the memory, and `PAUSED` is the
  safe default. This is intended.
- Any new path into `ESTOP` must go through the `ESTOP` entry rows, so that `RECORD_ESTOP_ORIGIN` runs. The
  invariant tests (I2) and the Python parity test cover the rows.
- No cloud input chooses the target. The release stays lock-gated and Operator-only, so the security impact is nil.
- Cost: none.
- Amends the release target in ADR 0028 and SPEC §6. See the notes in ADR 0028.
