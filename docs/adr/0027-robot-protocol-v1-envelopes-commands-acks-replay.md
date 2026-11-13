# ADR 0027 — Robot protocol v1: envelopes, commands, acks and replay rules

- Status: accepted
- Date: 2026-11-01
- Requirements: FR-CMD-1, FR-CMD-4, FR-CMD-5, FR-ROB-3, SEC-CMD-1, NFR-MAINT-1, T4, T5, T19

## Context

The robot agent (Python, on the Kali VM or in the simulator) and the cloud (TypeScript Lambdas and the console)
exchange messages over AWS IoT Core. Both sides must agree on every field, and a field that is wrong in a
safety path (a command accepted when it should be refused, an acknowledgement that never comes) is hard to see
in a demo. Commands come from a stateless Lambda, so a per-robot sequence number would need an atomic counter
write for every command. The robot wall clock is NTP-synchronised but can drift. A `HEARTBEAT` at 4 Hz would
double the traffic if every heartbeat were acknowledged.

## Decision

- **One source of truth for the shapes.** The zod schemas in `packages/protocol` are the authority. Each schema
  marked for export is written to `packages/protocol/generated/` as JSON Schema (draft 2020-12). The Python
  mirror in `agent/src/fleet_agent/protocol/` is written by hand, not generated, and both sides are checked against
  one fixture corpus: every valid file must pass and every invalid file must fail in zod, in `jsonschema` and in
  pydantic (D11). Generated Python would fight `mypy --strict`, and a shared corpus is a stronger sync test.
- **Robot to cloud: full envelope.** Telemetry, events and acks carry `schemaVersion`, `messageId` (UUIDv7),
  `robotId`, `siteId`, `ts`, `seq` (integer 0 to 2^53 − 1) and `bootId` (UUIDv7, fixed for one process). `seq` is
  shared by the three kinds of one boot, so the cloud orders them by `(bootId, seq)`.
- **Cloud to robot: no sequence.** A command carries `schemaVersion`, `messageId`, `robotId`, `siteId`, `ts`,
  `commandId` (UUIDv7), `issuedAt`, `issuedBy`, `correlationId`, an optional `lockToken`, and a `type` with its
  `params`. A command has no `seq` and no `bootId` (G5). Replay protection uses `commandId` and `issuedAt`.
- **UUIDv7 identifiers are lowercase only.** The schema refuses uppercase hexadecimal. One identifier then has one
  spelling, so the replay memory cannot be bypassed by changing the case of an id.
- **Replay pipeline, in this order, first failure wins.**
  1. A payload over 4096 bytes is dropped with no ack.
  2. The payload must parse as JSON, and both `commandId` and `correlationId` must be valid. Otherwise the command
     is dropped and logged with no ack: nothing trusted can be answered, and an ack without a valid correlation id
     cannot be matched by the console.
  3. A schema error, or a major other than 1, is `REJECT INVALID`.
  4. A `robotId` or `siteId` other than the robot's own is `REJECT INVALID`.
  5. A `commandId` already seen is `REJECT DUPLICATE`. The id is recorded when it arrives, so a rejected id is
     still a duplicate later.
  6. The age `now − issuedAt`, on the robot wall clock, must lie in `[−1000, +2000]` ms. Outside that window the
     command is `REJECT EXPIRED`, except `ESTOP`.
     The lock, simulation and state checks follow; ADR 0028 defines them.
- **Correlation id contract.** The cloud mints `correlationId` as a UUIDv7 for every command, and the robot echoes it in
  the ack. API Gateway request ids end in `=`, which `CorrelationIdSchema` refuses, so the console and the API must not
  reuse them as correlation ids. M9 adds a contract test that the output of the command builder passes `CommandSchema`.
- **Replay memory.** The robot keeps the last 1000 command ids per boot. At the IoT limit of 100 publishes per second
  per connection this covers 10 s, five times the 2 s age window. A test in `constants.test.ts` keeps that inequality
  true when a constant changes.
- **E-stop exempt from the age window (D13).** `ESTOP` is still schema-checked and deduplicated, and it needs no lock
  (FR-CMD-4). A stale or replayed e-stop can only stop the robot, and a skewed clock must never block it. A repeated
  `ESTOP` id gets `REJECT DUPLICATE`, so the console mints a new `commandId` for each press. The console shows
  `DUPLICATE` on an `ESTOP` as "already applied".
- **Acknowledgements (G9).** Every command that passes step 2 gets exactly one answer: `ACK`, or `REJECT` with one of
  six reasons. The schema makes the reason mandatory on `REJECT` and forbidden on `ACK`. `HEARTBEAT` is never
  answered; its refusals are logged at most once a second. A lock lost to a takeover or to expiry is reported by a
  `LOCK_CHANGED` event, not by an ack.
- **Clean shutdown (G7).** On SIGTERM the robot publishes `GOING_OFFLINE` (reason `SHUTDOWN`). The robot never reports
  `OFFLINE`: the cloud sets that state on disconnect or after 15 s of silence (ADR 0028).
- **Telemetry rate (D20).** A real robot publishes telemetry at 2 Hz in every state. A simulated robot publishes at
  0.5 Hz while it moves, publishes at once on a state change, and sends a `HEARTBEAT` event after 5 s of silence.
- **Identifiers (D12).** UUIDv7 (RFC 9562 §5.7) is implemented in `packages/protocol/src/uuidv7.ts` and in
  `agent/src/fleet_agent/core/ids.py`, about twenty lines each, with tests. Python 3.12 has no `uuid7`, and each
  language would otherwise take a dependency for that small function.
- **Shared name grammar.** The display name of a robot is `^[A-Za-z0-9À-ÖØ-öø-ÿ ._-]{1,64}$` in zod, in the Python
  mirror and in the JSON Schema. ASCII plus Latin-1 letters cover French names. The pattern needs no `u` flag in
  JavaScript, and Python `re` and the ECMA dialect of JSON Schema both compile it without a dependency.
  The `\p{L}` class was rejected because it needs the `u` flag and, in Python, the `regex` package and a custom
  JSON Schema validator.
- **Private-key shape (PEM).** The kit schema requires the header and the footer of a PEM private key to match
  (`PRIVATE KEY` with `PRIVATE KEY`, or `RSA PRIVATE KEY` with `RSA PRIVATE KEY`). The pattern is built so that the
  literal header text never appears in the generated JSON Schema, because a secret scanner flags a committed key
  header (see `docs/JOURNAL.md`, 2026-11-01).

## Accepted deviations

One deviation remains on 2026-11-01. The zod schema is the authority for every item below. The parity tests do not
exercise these inputs, so the zod side is the only control for them.

2. **The validators disagree on three edge cases.**
   - 2a. pydantic in strict mode refuses `1.0` for an `int` field (checked with pydantic 2.14.1). zod and JSON Schema
     accept `1.0`, because it is an integer.
   - 2b. `jsonschema` uses Python `re`, where `\d` matches non-ASCII digits (checked).
   - 2c. In `jsonschema`, `$` matches before a trailing newline (checked).
   - 2d. The cross-field rules of `RobotKitConfig` and `VideoSession` (thing name = prefix + robot id, one region, the
     channel named by its ARN) exist in zod and pydantic only: JSON Schema 2020-12 cannot state field equality. The parity
     test records those fixtures (`cross-field-*`) as refused by pydantic and accepted by the generated schema.

## Alternatives considered

| Option                                                            | Pros                                                        | Cons                                                                                   | Why not                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Per-robot sequence on commands, with an atomic DynamoDB counter   | Total order of commands per robot                           | A write per command, a hot item per robot, a new failure mode in a stateless Lambda    | The command window and the replay memory already bound replay; ordering is not a safety property     |
| Generated Python models (`datamodel-code-generator`)              | No hand-written mirror to drift                             | Generated code fights `mypy --strict`; the fixture corpus checks parity more strictly  | D11                                                                                                  |
| Acknowledge every `HEARTBEAT`                                     | Uniform rule: every command gets an answer                  | Doubles traffic at 4 Hz for no safety gain                                             | G9. Lock loss is reported by `LOCK_CHANGED`                                                          |
| `ESTOP` subject to the age window                                 | One rule for all commands                                   | A robot clock ahead or behind by more than the window blocks the stop                  | D13. A stale stop only stops the robot                                                               |
| `uuid` (npm) and `uuid6` (PyPI) for UUIDv7                        | Maintained libraries                                        | Two new dependencies for about twenty lines each                                       | D12. The layout is covered by tests in both languages                                                |
| Unicode name grammar (`\p{L}`) with the `regex` package           | Full French and other Latin scripts, all of Unicode letters | Needs the `u` flag, a dependency and a custom JSON Schema validator on the Python side | Latin-1 covers the demo's names; a new dependency is not worth it                                    |
| Footer independent of the header in the PEM pattern (first draft) | Simpler pattern                                             | Accepts a block whose END line does not match its BEGIN line                           | The S1.1 ruling asked for equality, and the equality is kept with the literal kept out of the schema |

## Consequences

- Adding or changing a field means changing the zod schema, the Python mirror, the fixtures in both languages and the
  generated files, in one commit. `make check-generated` fails when the generated files are stale.
- The cloud cannot order commands by sequence. Replay across a reboot is caught by the age window unless the reboot
  takes less than 2 s, which is accepted; server-side idempotency covers it in M9.
- The robot clock must be NTP-synchronised. A skew beyond the window makes the robot refuse non-ESTOP commands with
  `EXPIRED`, which is visible to the operator and does not weaken safety.
- The replay memory size is part of the protocol. Raising the publish limit or the window requires a larger
  `REPLAY_LRU_SIZE`, and the constants test fails until it is.
- No table write happens per command, so the command path adds no DynamoDB cost (NFR-COST).
- Known limitation: the invalid fixtures assert that each file is rejected. They do not assert which step refused it, so
  a file can be refused for a different reason and still pass. The review accepted this. A sidecar index that names the
  expected failing path is the follow-up.
- The schema check of a private key is only a shape check. The agent's start-up check of the key file (P4) is the
  control that refuses a file that is not a private key.
- The review findings in this ADR are applied on the same branch by a separate code change. This ADR describes that
  contract. The command pipeline, the replay guard, the sequencer and the telemetry scheduler belong to the agent core
  (P4).
- The threats this ADR serves are T4, T5 and T19; see `docs/security/THREAT_MODEL.md`.
