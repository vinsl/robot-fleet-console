# ADR 0034 — Agent core: ports and adapters, synchronous pipeline, lock, deadman and e-stop latch

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-CMD-1, FR-CMD-2, FR-CMD-3, FR-CMD-4, FR-CMD-5, FR-ROB-3, NFR-REL-1, NFR-OBS-1, SEC-CMD-1, SEC-SEC-1, T4, T9, T12, T15, T19, T23

## Context

The robot agent must stop safely when the console or the link goes silent, must not undo an e-stop across a
reboot, and must keep its safety logic testable without a broker. ADR 0027 fixes the message rules and ADR 0028 fixes
the state table, the lock, the deadman and the latch. This ADR records how the agent core executes them. In P4 the
core has no actuator port: its motion is a model, and no drive command reaches hardware. The core therefore has to be
right about state, not about timing on a real drive, and its tests must be deterministic.

## Decision

The agent core (`agent/src/fleet_agent/core/`) is one synchronous class, `AgentCore`, that owns the robot model, the
lock, the deadman, the replay memory and the scheduler. It does no I/O of its own. It reaches the world through three
ports: `Clock`, `Transport` and `LatchStore`. It is driven by a 50 ms tick and by transport callbacks, which the
transport marshals onto the event-loop thread. Every listener method and every publish callback runs on that thread,
so the core needs no lock.

- **Ports and adapters.** The core modules import no `asyncio`, no socket and no file API. The identifier source
  defaults to `os.urandom`, and the jitter source to `random.random`. Both are injected parameters, so tests can replace
  them. The MQTT transport and the latch file are adapters. Their code lands in PR B.
- **Module split.** `agent.py` holds `AgentCore`: the pipeline, the lock and deadman checks, the calls to the state
  table and the tick, in the safety order. The other modules of the core each hold one responsibility. `outbox.py` is
  the one door to the transport, with the QoS 1 cap and the priority headroom for an e-stop. `announcer.py` publishes the
  outputs of a transition in their fixed order and records whether the latch is persisted. `telemetry.py` builds the
  telemetry and the heartbeat, and `scheduler.py` decides when they are due. `subscription.py` subscribes to the command
  topic and retries a refused SUBACK. `corelog.py` is the core's log writer, with the strict check the tests apply.
  `identity.py` holds who the robot is. `snapshot.py` is the read-only view and the banner. `commands.py` holds the pure
  helpers that read a screened command. The state table, the effects, the lock, the deadman, the screening, the replay
  memory and the message builders stay in their own modules. `timefmt.py`, the ISO 8601 helpers, sits in the package
  root and not in the core, because `logs.py` uses it and the logging must not depend on the core. The reason for the
  split is that the safety pipeline reads in one short file, and each responsibility can be tested on its own, without
  the others.
- **Pipeline, one callback per command, first failure wins.** The stages run in this order. The ADR 0027 step is
  given for each stage that it names.

  | Order | Stage       | Failure                                                                                                   | ADR 0027 step |
  | ----- | ----------- | --------------------------------------------------------------------------------------------------------- | ------------- |
  | 1     | SIZE        | payload over 4096 bytes: dropped, no answer                                                               | 1             |
  | 2     | TOPIC       | not the robot's own command topic: dropped                                                                | not named     |
  | 3     | PARSE       | not a UTF-8 JSON object, duplicate key, NaN: dropped                                                      | 2             |
  | 4     | IDS         | `commandId` or `correlationId` malformed: dropped                                                         | 2             |
  | 5     | SCHEMA      | strict schema or major other than 1: REJECT INVALID                                                       | 3             |
  | 6     | OWN_IDS     | another robot or site: REJECT INVALID                                                                     | 4             |
  | 7     | DUPLICATE   | identifier seen before: REJECT DUPLICATE                                                                  | 5             |
  | 8     | AGE         | outside `[-1000, +2000]` ms, ESTOP exempt: REJECT EXPIRED                                                 | 6             |
  | 9     | UNSUPPORTED | `DRIVE`: REJECT INVALID                                                                                   | not named     |
  | 10    | SIMULATED   | `SIMULATE_FAULT` on a real robot: REJECT NOT_SIMULATED                                                    | not named     |
  | 11    | LOCK        | lock-required command without the holder, or `TAKE_CONTROL` against a live holder: REJECT NOT_LOCK_HOLDER | not named     |
  | 12    | STATE       | table REJECT, or `INVALID_STATE` on a table fault or a failed latch clear, except an `ESTOP` (see below)  | not named     |

  The identifier is recorded at stage 7, after stages 5 and 6 have passed. A schema-invalid or misaddressed message
  therefore cannot use up an identifier that a legitimate command needs. A recorded identifier stays recorded when a
  later stage refuses the command, so a replay is `DUPLICATE` even if the first copy was `EXPIRED`. A `HEARTBEAT`
  refused at any stage is silent. Every other message that reaches stage 5 gets exactly one answer, unless the core halts
  while it runs.

- **Lock, deadman and latch, in the order they run.**
  1. When the lock has been idle for `LOCK_IDLE_EXPIRY_MS`, the lock is released. In `TELEOP` the robot goes to `PAUSED`.
     This runs before the lock check, so a late operator cannot take a lock that has already lapsed.
  2. A lock-required command (`PAUSE`, `RESUME`, `RETURN_TO_BASE`, `ESTOP_RELEASE`, `RELEASE_CONTROL`, `HEARTBEAT`,
     `DRIVE`) must carry the holder's `(lockToken, issuedBy)`. Both fields are compared in constant time, and both are
     always compared. A match touches the lock's idle timer at the arrival time, and feeds the deadman at the issue time:
     the arrival time minus the age, or the arrival time when the command has no age or a future one. The deadman feed
     never moves its deadline back, so a late copy of an older command cannot extend the window past a proof of life
     already recorded. The lock timer is not moved to the issue time, so a command delayed by up to 2 s can keep the lock
     up to 2 s longer than the operator's last activity (accepted risk R33). A mismatch is refused before either
     happens, so a delayed or replayed holder message cannot keep the robot alive.
  3. `TAKE_CONTROL` is refused while another holder is live. A takeover is possible only after the idle expiry above.
     An expiry that ran in a tick counts as an expiry like any other: `RobotLock` keeps the expired holder pair, redacted
     in its representation, until the next grant. A grant to another operator after such an expiry is therefore reported
     as `TAKEOVER`, not `ACQUIRED`. An accepted `TAKE_CONTROL` feeds the deadman at its issue time, as in step 2.
  4. The deadman is armed only while the lock is held and the state is `TELEOP`, `MOVING` or `WORKING`. When it expires
     the robot goes to `PAUSED` with its resume target kept (ADR 0028). The deadman is checked on every tick, so it
     runs while the link is down.
  5. `ESTOP` needs no lock and is exempt from the age window. Its effects are `STOP_MOTION`, `ABORT_MISSION` and
     `LATCH_ESTOP`, and it is still acted on while the agent is stopping (see Shutdown). `CLEAR_ESTOP_LATCH` is the only
     effect that can fail before anything changes: when the latch cannot be removed, `ESTOP_RELEASE` is refused with
     `INVALID_STATE` and the robot stays in `ESTOP`.
  6. The outputs of a command are published in this order: the ACK, then `STATE_CHANGED`, then `LOCK_CHANGED`, then the
     fault events, then the latch log line. A state change requests an immediate telemetry message.
- **E-stop latch.** The stop never waits for the latch. A failed `LATCH_ESTOP` write still stops the robot and is
  acknowledged. It is logged at ERROR and reported in the snapshot. Four rulings made while implementing refine this
  section:
  - `ESTOP` while already in `ESTOP` is an `ACK` with state `SAME`, and the table gives that row no `LATCH_ESTOP`. The
    table is the source of truth: the row is pinned by the parity test `test_the_python_table_equals_the_generated_rows`,
    and the first latch stands. The core adds one thing to that row. While `latch_persisted` is false, an `ESTOP` retries
    the write with the new command as its cause, so a failed write is not left unrepaired until a reboot
    (`test_a_failed_estop_latch_is_retried_by_the_next_estop_and_then_persisted`). While the latch is persisted, a repeated
    `ESTOP` writes nothing (`test_an_estop_while_the_latch_is_in_place_writes_nothing_again`). This supersedes the draft
    that rewrote the latch on every repeated `ESTOP`.
  - `latch_persisted` is false only after a failed latch write, with no later successful write (`LATCH_ESTOP` or
    `CLEAR_ESTOP_LATCH`) since then. A failed clear does not change it.
  - An `ESTOP` that the table or the effects cannot process is never answered with a refusal. The core calls
    `_stop_in_place`, which zeroes the speed, clears the destination and sets the state to `ESTOP` before it writes the
    latch directly (`SET`, or `SET_FAILED` when the write fails). Then it halts. The robot reads as `ESTOP` whether or
    not the write succeeds, and no line is published
    (`test_an_estop_that_cannot_be_applied_stops_latches_and_is_never_refused`). A failing command other than `ESTOP` is
    refused with `INVALID_STATE`.
  - An issue time that cannot be read is refused `EXPIRED` for every command except `ESTOP`, which is accepted. The
    protocol pattern accepts year 0000, which the calendar does not have, so the age cannot be computed. Failing closed
    keeps the stop available and refuses everything else
    (`test_an_unreadable_issue_time_is_expired_but_a_stop_is_accepted`). Tightening the protocol pattern to a real
    calendar date is a follow-up in `packages/protocol`, with parity fixtures.
- **No command queue.** A command is processed synchronously, in one callback, from receipt to state change. Publishes
  are fire-and-forget. The only backlog is the QoS 1 outbox, capped at `MAX_PENDING_QOS1` (100). It drops with
  `outbox.full` rather than delaying anything. An e-stop's acknowledgement and its `STATE_CHANGED` are priority
  messages: they may use `PRIORITY_QOS1_HEADROOM` (8) slots above the cap, so an `ESTOP` is acknowledged even when the
  queue is full (`test_an_estop_is_acknowledged_and_announced_while_the_qos1_queue_is_full`, and
  `test_a_priority_message_takes_only_the_headroom_beyond_the_cap` in `agent/tests/core/test_outbox.py`). The count is
  clamped at zero when a transport reports one publish twice (`test_a_publish_reported_twice_cannot_lift_the_cap`). A
  second report of one publish can still free another message's slot, which lets the cap be exceeded by one. This is
  accepted (R35). The transport adapter (PR B) is specified with clean sessions, so the broker keeps nothing for a robot
  between connections. An `ESTOP` therefore never waits behind a queued command. The headroom is the only ordering rule,
  and FR-CMD-4 is met by this structure and that headroom, not by a queue discipline.
- **Shutdown keeps the stop.** `begin_shutdown()` sets the stopping flag, zeroes the speed and clears the destination at
  once, so the robot stops. It returns nothing. The tick keeps the speed at zero while the agent is stopping, so a robot
  that was moving does not move again. The state is left untouched on purpose: a shutdown is not a transition of the
  state machine, so it runs neither the stop path of the table, nor the deadman, nor the latch. The final telemetry may
  therefore still show the state from before the stop, at speed zero, until the goodbye. A stopping core drops every
  command except an `ESTOP` that passes screening, which is still acted on: a shutdown is never a reason to refuse a
  stop. The other drops are logged at most once per interval. `build_goodbye()` builds the `GOING_OFFLINE` event with
  reason `SHUTDOWN`. The runner calls it when it is ready to send, after `begin_shutdown()` and after the last publish.
  The message takes its sequence number when it is built, so it carries the highest number of the boot
  (`test_the_goodbye_sequence_is_above_every_message_published_before_it`, and
  `test_begin_shutdown_takes_no_sequence_number_until_the_goodbye_is_built` in `agent/tests/core/test_agent_commands.py`).
  The goodbye is published by the runner, not through the outbox, so the QoS 1 cap does not apply to it. Before this
  shape, `begin_shutdown` built the goodbye and took its sequence number at the start of the shutdown, so an
  acknowledgement sent during the shutdown carried a higher number than the goodbye.
- **Halt on an unexpected exception.** `halt(reason)` zeroes the speed, clears the destination without the state table,
  logs CRITICAL `agent.halted` with the exception class name only, and refuses all further work. One exception: a halted
  core still acts on a screened `ESTOP` (`_estop_after_halt`). That path runs neither the table nor the effects. It
  stops in place (`_stop_in_place`), makes one attempt to write the latch without halting again, and sends a best-effort
  priority acknowledgement with no `STATE_CHANGED`. A failing acknowledgement is logged and not raised. Every other
  command stays dropped. The core halts itself when an internal trigger matches two rows, and when an effect of an
  internal trigger cannot be applied (`_fire_internal` catches `EffectError`), because the table and the model then
  disagree. Any other unexpected exception propagates to the runner, which calls `halt()` and exits with code 70. The
  runner is PR B.
- **Logging.** Every line goes through `logs.py`, which holds the closed list of event names and `LOG_FIELDS`, the
  allowlist of field names. The formatter drops any other field, and any value that is not a scalar or a list of
  strings. It writes a record of a logger outside `fleet_agent`, or an agent record whose message is not a listed
  event, as `foreign.log` with its level and logger only: its message and its arguments are never read, so a value
  that a library quotes cannot leak. `logs.py` does not depend on the core. In production the core's `CoreLog` never
  raises on the safety path. An event outside the closed list writes nothing, and a field outside the allowlist is left
  out and counted in `droppedFields`. `CoreLog` and the strict check decide what a call loses with one helper,
  `_refused_keys` in `corelog.py`, so the writer and the check cannot disagree. The formatter keeps its own check against
  the same allowlist. The tests are where a loss is caught: an autouse fixture in `agent/tests/core/conftest.py` checks
  every core log call with `unloggable_reasons` and fails the test that would lose something
  (`test_a_core_log_call_that_would_lose_a_field_fails_the_test`). Never logged: payloads, lock tokens, `issuedBy`,
  exception messages (the class name only), and the content of a pydantic error (its paths only). The holder's subject
  appears only in the `LOCK_CHANGED` event, which the protocol requires. Tracebacks, when logged, carry file, line and
  function only.

## Alternatives considered

| Option                                                      | Pros                                   | Cons                                                                                                                               | Why not                                                                                      |
| ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Async core with awaits inside the pipeline                  | Native fit with the MQTT SDK           | Any await can interleave an ESTOP with a half-applied command; tests need an event loop                                            | Deterministic tests with a fake clock, and no await in a safety path                         |
| Lock check before the age window                            | One fewer stage                        | A delayed or replayed holder message could keep the deadman alive                                                                  | Age first, then the lock                                                                     |
| Refuse `ESTOP` when the latch cannot be written             | The latch is always current            | The robot cannot be stopped while the disk fails                                                                                   | T19. A stop is never refused; the failure is reported (R30)                                  |
| Log and continue after an unexpected exception              | The link stays up                      | A core in an unknown state keeps moving                                                                                            | Speed zero and exit 70                                                                       |
| Priority queue with `ESTOP` first                           | Standard answer to FR-CMD-4            | There is no backlog to overtake, so a queue would be dead code                                                                     | Synchronous processing and a bounded cap; an `ESTOP` gets reserved headroom above the cap    |
| Rewrite the latch on every repeated `ESTOP` (earlier draft) | `latchedAt` tracks the latest press    | An extra write per press, and a table that gives no effect for the same state                                                      | The table is the source of truth. The write is retried only while the latch is not persisted |
| Feed the lock idle timer at the issue time                  | No lock extension by a delayed command | The issue time comes from the age, which is computed from the sender's wall clock, so a skewed clock would move the lock timer too | Accepted risk R33: the extension is bounded by the 2 s age window on a 30 s timer            |
| `structlog` for the logs                                    | Processors, context binding            | A new dependency, and the allowlist would still be a custom processor                                                              | Stdlib `logging` plus a formatter needs no dependency                                        |
| Raise `ValueError` on an unlisted log event or field        | A leak or a typo fails at once         | A logging bug on the safety path stops the core                                                                                    | Drop and count in production; the tests fail on any loss                                     |
| Free-form logging with a review rule against secrets        | Less code                              | A leak depends on the reviewer                                                                                                     | The allowlist makes a leak a code change that a test catches                                 |

## Consequences

- The core is testable without a broker, a loop or a disk. The 428 core and logging tests (`agent/tests/core` and
  `agent/tests/test_logs.py`) pass in about one second in the development container. The core also has a clear contract: the
  loop-thread rule applies to the adapters, and a violation of it is a bug in them, not in the core.
- The core's correctness depends on the adapters keeping the loop-thread contract (PR B). The security review focuses
  on the marshalling code.
- R29 applies. Motion can start without a lock holder through `IDLE` to `MOVING` on `BATTERY_LOW`. The core raises that
  trigger itself when the modelled battery drains, on every robot, real or simulated, and the robot then goes to its
  charger. It is not armed for the deadman, so it runs to arrival while the link is down. The mission triggers
  `MISSION_ASSIGNED` (from `IDLE`) and `WORK_DONE` (from `WORKING`) also start motion without a lock, but nothing raises
  them before M5. No actuator port exists in P4, so no drive receives the motion. Recorded in THREAT_MODEL as an accepted
  risk.
- R30 applies. A failed latch write leaves the e-stop in memory only, and a reboot before the next successful write boots
  in `IDLE`. A repeated `ESTOP` retries the write while the latch is not persisted, so the next press may persist it. The
  core does not retry on its own, which keeps it synchronous and free of I/O waits. Recorded in THREAT_MODEL as an
  accepted risk.
- R33 applies. A command is accepted up to 2 s after its issue time, and the lock's idle timer restarts at its arrival
  time. A delayed command can therefore hold the lock up to 2 s longer than the operator's last activity, on a 30 s idle
  timer. The deadman is fed at the issue time, so the delay does not keep a robot moving. Recorded in THREAT_MODEL as an
  accepted risk.
- Adding a log field or an event name is a change to `logs.py`, which the tests check. The allowlist is the place to look
  when a new field is needed.
- The synchronous model means a slow adapter delays the tick. The adapters must return quickly, and the publish callbacks
  must not block.
- The runner (PR B) must wrap every callback in a halt guard. A `TypeError` for a table or internal fault can escape a
  callback after an acknowledgement has been sent. Any unexpected exception must therefore call `halt()` and exit with
  code 70, even when the acknowledgement already went out. This is a PR B requirement, tracked as an unticked item in
  `docs/security/CHECKLIST.md`.
- Two ordering rules for the runner (PR B). It must build the goodbye with `build_goodbye()` immediately before
  publishing it and stop feeding the core after that, because an ESTOP accepted later would otherwise carry a higher
  sequence number than the goodbye. A halted core acts on an ESTOP (stop, latch, priority acknowledgement) but publishes
  no state change and no telemetry, so the console must treat an acknowledgement carrying state `ESTOP` as authoritative.
- The deadman has a latency budget. A command aged 1000 ms or more never extends the deadman window, so an operator
  whose clock is more than 1 s behind cannot keep a robot teleoperated: the robot pauses. This fails safe and is an
  availability limit. A lock acquisition does not reset the deadman; only a feed does (T12).
- Two accepted risks come from the round-2 review. R34: `RobotLock.release()` does not clear the expired-holder marker,
  because the `LOCK_EXPIRED` rows release the lock right after the expiry, and clearing it would break the `TAKEOVER`
  label. A stale marker can therefore label a much later grant as a takeover, which is an audit label only. R35: a
  transport that reports one publish twice can free another message's QoS 1 slot. Both are recorded in
  `docs/security/THREAT_MODEL.md`.
- No cloud cost: the core makes no AWS calls itself.
- The threats this ADR serves are T4, T9, T12, T15, T19 and T23; see `docs/security/THREAT_MODEL.md`.
