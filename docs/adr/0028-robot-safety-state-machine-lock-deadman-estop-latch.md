# ADR 0028 — Robot-side safety: state machine, lock, deadman and e-stop latch

- Status: accepted
- Date: 2026-11-01
- Requirements: FR-CMD-1, FR-CMD-2, FR-CMD-3, FR-CMD-4, T12, T15, T19, T23

## Context

The robot must stop safely when the cloud, the console or the network does not respond, and a restart must not
undo a stop. The specification (SPEC §6) says that `BLOCKED` is left only by `RESUME` or `RETURN_TO_BASE`, and that
`ESTOP` is reachable from every state. Those two rules conflict for a robot that is blocked when an e-stop arrives.
The specification ties the deadman to teleoperation only, but a robot that returns to base under a held lock also
moves, and the deadman must cover it. The control lock is enforced in the cloud (T15); the robot keeps its own copy,
so that a faulty or replayed grant cannot take a robot from its operator. An e-stop must survive a reboot (SPEC §6
invariant).

## Decision

- **One table, written once.** The transition table is written in set notation in `packages/protocol/src/state-machine.ts`
  and expanded into one row per (origin, trigger, guard), with the effects, the reply and, on a refusal, the reason.
  The generator writes `packages/protocol/generated/state-machine.json` and `docs/STATE_MACHINE.md`. The agent's
  `agent/src/fleet_agent/core/state_machine.py` mirrors the table, and a parity test compares the two row for row.
  The lock command sets (`LOCK_REQUIRED_COMMANDS`, `LOCK_FREE_COMMANDS`) are exported in `generated/constants.json`
  and compared by the same parity test, so the two languages cannot disagree on which command needs the lock.
  A pair with no row is refused with `INVALID_STATE` when it is a command, and ignored when it is internal.
- **Fail closed on ambiguity (T23).** When more than one conditional row matches the same origin and trigger,
  `transition()` does not pick one. A command is refused with `REJECT INVALID_STATE`, and an internal trigger raises
  `TypeError`. The invariant tests cover this in TypeScript and in Python. The earlier rule that the caller must pass
  exclusive guards is replaced by this check.
- **`transition()` refuses an `OFFLINE` origin.** The robot never holds `OFFLINE`, so an `OFFLINE` origin raises
  `TypeError` instead of matching a row.
- **`ESTOP` wins (G6).** `ESTOP` leads from every reported state to `ESTOP`. From `ESTOP` the only exit is
  `ESTOP_RELEASE`, which goes to `PAUSED` and never to a motion state (amended by ADR 0073: to `IDLE` when the robot was
  `IDLE` at the e-stop). `BLOCKED` is left only by `RESUME` after its
  cause is cleared, by `RETURN_TO_BASE`, or by `ESTOP`. The table never refuses `ESTOP` (T19): the pipeline refuses it
  only for schema, own-id or duplicate reasons (ADR 0027). Eight invariants (I1 to I8) are tested over the TypeScript
  table in `packages/protocol/test/state-machine.test.ts`, and the parity test holds the Python table equal to it.
- **Releasing an e-stop takes the lock first.** `ESTOP_RELEASE` is lock-gated on the robot, like the other releases.
  To release an e-stop, the console sends `TAKE_CONTROL` first. The table allows it in `ESTOP` and it acquires the lock.
  Then it sends `ESTOP_RELEASE`, which goes to `PAUSED`, never to a motion state. Amended by ADR 0073: when the robot was
  `IDLE` at the e-stop, the release goes to `IDLE`.
- **The cloud never filters `ESTOP` by state.** The cloud sends every `ESTOP`, whatever state it holds for the robot,
  and the robot table decides.
- **The deadman follows the lock and the motion (G8).** It is armed while the robot lock is held and the state is
  `TELEOP`, `MOVING` or `WORKING`. It times out after `DEADMAN_TIMEOUT_MS` (1000 ms) without a valid command from the
  holder. Expiry stops the motion and moves to `PAUSED` with the resume target kept. The check runs every 50 ms, so
  the worst case is about 1.05 s. It runs while the MQTT link is down, which is its purpose (T12).
- **Robot-side lock (D14).** The robot stores the holder's token and subject, and compares the pair `(token, sub)` in
  constant time. A `TAKE_CONTROL` from another pair is refused until the lock has been idle for
  `LOCK_IDLE_EXPIRY_MS` (30 s) on the robot's monotonic clock. A takeover of an idle-expired lock first applies the
  expiry: `LOCK_CHANGED` with cause `EXPIRED`, and the internal `LOCK_EXPIRED`, which in `TELEOP` goes to `PAUSED`.
  Then the new holder gets the lock, with `LOCK_CHANGED` cause `TAKEOVER`. A race between the cloud and the robot is
  possible for a few hundred milliseconds: the robot answers `NOT_LOCK_HOLDER`, and the console retries once after 1 s
  (the M9 contract).
- **E-stop latch (D15).** `ESTOP` writes the file `estop.latch` in the kit directory, atomically, with mode 0600
  (effect `LATCH_ESTOP`). At boot the agent starts in `ESTOP` if the file exists, and in `IDLE` otherwise. `ESTOP_RELEASE`
  removes the file and goes to `PAUSED`; amended by ADR 0073, it goes to `IDLE` when the robot was `IDLE` at the e-stop,
  and the origin is kept in memory only. The agent refuses to start when the latch file exists but cannot be read.
- **Boot rows (Q1).** The origin `START` is not a reported state. Only the two `BOOT` rows use it, with the guards
  `LATCH_SET` and `LATCH_NOT_SET`. A `STATE_CHANGED` event never carries the cause `BOOT`; the boot is announced by the
  `BOOT` event.
- **Cloud rows are separate (Q2).** `CloudTrigger` (`CLOUD_DISCONNECTED`, `CLOUD_SILENCE_15S`, `ROBOT_REPORTED`) is
  not part of the robot `Trigger`, and the robot never acts on it. Every reported state goes to `OFFLINE` on either
  disconnect trigger, and `OFFLINE` returns to the reported state on `ROBOT_REPORTED`. `transitionCloud(state,
trigger, reported?)` returns `{ to, changed }`, throws `TypeError` when `reported` is needed and missing, and returns
  the state unchanged for a pair with no row. The robot table never targets `OFFLINE` (I6).
- **A no-op is an ACK on the wire (Q3).** Each row carries `reply`: `ACK`, `REJECT` or `NONE`. `NONE` is used for
  `HEARTBEAT` and every internal row, and a `REJECT` row carries its reason. A no-op is an `ACK` with `changed = false`,
  and its effects still run: `TAKE_CONTROL` in `TELEOP` refreshes the lock holder. `changed` is `to !== from`.
- **Resume targets.** `RESUME_TARGET_FROM` stores the state the robot was in before the stop. `RESUME_TARGET_IDLE`
  stores `IDLE` after an e-stop release, a release of control and a lock expiry, so that a mission is never resumed
  silently. A resume target is never `ESTOP`: `transition()` refuses `ESTOP` as a resume target with `TypeError`.
- **Name grammar.** The display-name grammar is decided in ADR 0027 and is not repeated here.

## Alternatives considered

| Option                                                                          | Pros                          | Cons                                                                                   | Why not                                                            |
| ------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Follow SPEC §6 literally: `BLOCKED` leaves only by `RESUME` or `RETURN_TO_BASE` | Matches the text              | An e-stop on a blocked robot would be refused or delayed, which breaks T19             | G6. `ESTOP` must win from every state                              |
| Deadman only in `TELEOP` (SPEC §6 wording)                                      | Smallest rule                 | A robot returning to base with a lock holder who disconnects keeps moving with no link | G8. The lock and the motion together are what the deadman protects |
| Robot trusts any token it receives                                              | No state to keep on the robot | Any token holder can take a robot while another operator drives it (T15)               | D14. Defence in depth, even though the cloud checks the lock       |
| E-stop kept in memory only                                                      | No file on the robot          | A restart clears the stop; the SPEC §6 invariant fails                                 | D15                                                                |
| Boot always in `IDLE`                                                           | Simpler boot                  | A reboot clears an e-stop without an operator                                          | The latch rows                                                     |
| Robot reports `OFFLINE` itself on shutdown                                      | Explicit                      | A robot that crashes or loses power cannot report it                                   | G7. The cloud sets `OFFLINE` from disconnect or silence            |
| Caller passes exclusive guards (first draft)                                    | No check in the table         | Correctness depends on every caller; an overlap is silent                              | T23. `transition()` refuses an overlap itself                      |
| Two hand-written tables (TypeScript and Python)                                 | No generator                  | Drift between the console and the robot in the most safety-critical code               | One generated table and a row-for-row parity test                  |
| A state machine library                                                         | Standard vocabulary           | A runtime dependency on the robot, and a table the parity test cannot read directly    | A plain table, exhaustively tested, is easier to review            |

## Consequences

- Any change to a row changes `generated/state-machine.json` and `docs/STATE_MACHINE.md`. The agent's parity test
  fails until the Python table matches, and the invariant tests fail if a change breaks I1 to I8 or creates an overlap
  between conditional rows.
- After a power cut, a robot that was stopped by an e-stop stays stopped until an operator releases it. This is
  intended. It also means a stale latch file needs a human to clear it, through `TAKE_CONTROL` and `ESTOP_RELEASE`.
- A console that cannot take the lock cannot release an e-stop. The M9 console must implement the sequence
  `TAKE_CONTROL` then `ESTOP_RELEASE`.
- The deadman and the lock work on the robot's monotonic clock and with no network. A link loss while a lock holder
  is teleoperating or the robot moves under that lock stops the robot within about 1.05 s. A mission with no lock holder
  is not armed, so the deadman does not stop it; the e-stop is the stop for that case.
- A race between the cloud and the robot on lock expiry costs the console one retry after 1 s. The M9 console must
  implement that retry.
- Status of the code: the review findings in this ADR are applied on the same branch by a separate code change, and this
  ADR describes that contract. The lock, the deadman, the latch file, the command pipeline and the orchestration of
  effects belong to the agent core (P4). The rows above are the contract those parts must meet.
- The threats this ADR serves are T12, T15, T19 and T23; see `docs/security/THREAT_MODEL.md`.
