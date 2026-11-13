# ADR 0066 — Robot panel: command and lock stores, one-click e-stop, confirmed release, retry on lock race

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-CMD-1, FR-CMD-2, FR-CMD-4, FR-CMD-5, FR-I18N-1, NFR-A11Y-1
- Threat: T52 (console side), T59 (no token in state), R86
- Implemented in (planned, M9): `apps/console/src/control/command-store.ts`, `apps/console/src/control/lock-store.ts`,
  `apps/console/src/control/use-command.ts`, `apps/console/src/control/use-control-lock.ts`,
  `apps/console/src/control/ack-text.ts`, `apps/console/src/robot/RobotPanel.tsx`, `apps/console/src/robot/EStopButton.tsx`,
  `apps/console/src/robot/CommandPanel.tsx`, `apps/console/src/robot/LockLine.tsx`, `apps/console/src/robot/CommandLog.tsx`,
  `apps/console/src/pages/RobotPage.tsx`

## Context

The robot panel is where an operator sends commands and sees the result. DESIGN 2.2 is locked, and SPEC 4.4 asks for the
ACK status and the round-trip latency of each command and for who holds the lock. Three facts shape the design:

- The result of a command arrives as a live frame (`command.ack`), and the lock changes arrive as `lock.changed` and
  `robot.event` frames. Neither is a resource the console fetches, so they do not belong in a query cache.
- The robot's answer reaches the console only, so a retry after a lost lock race has to be decided in the console.
- An e-stop is a safety action. It must not wait for another request, and a confirmation step delays it.

## Decision

- **Command store** (Zustand, `command-store.ts`). Each entry is keyed by `commandId` and holds the type, the robot, the
  send time, the status and the latency. A rolling log keeps the last 20 entries per robot. Latency is the ACK arrival
  minus the send time, both from `performance.now()`. The first terminal result wins: a later `DUPLICATE` never overwrites
  an `ACK`. A command with no answer after 5 s shows "No answer", using the REJECT visual, with no new entry in
  `COMMAND_VISUALS`.
- **Lock store** (Zustand, `lock-store.ts`), keyed by robot. It is seeded by `GET .../lock` when the panel opens and then
  patched by `lock.changed` and by `robot.event` `LOCK_CHANGED`. "Mine" means the holder equals the verified user id. The
  holder label is `Operator ` followed by the last four hex characters of the `sub`.
- **Retry on lock race.** On `REJECT NOT_LOCK_HOLDER` for a `TAKE_CONTROL`, the console retries the acquire once after
  `LOCK_RETRY_DELAY_MS` (1 s), with a new `commandId`. The cloud does not retry, because the robot's answer is seen only by
  the console.
- **E-stop is one click.** It sends at once, with a new `commandId` per press. It is never queued behind another request,
  and it stays enabled while the HTTP API answers, even when the socket is down. It is shown to Admin and Operator only.
- **Release is confirmed in the panel.** "Release e-stop" opens an in-panel `role="alertdialog"` with focus on "Confirm"
  and Escape to cancel. On confirm it acquires the lock, waits up to 3 s for the `TAKE_CONTROL` ACK, then sends
  `ESTOP_RELEASE`, which is lock-gated (ADR 0028). A failure at any step is shown in the log and keeps the button. No
  browser dialog is used.
- **Panel shape.** `RobotPage` keeps the `SidePanel` and renders `RobotPanel` in the focused mode of its route (DESIGN 2.2).
- **Deviations from DESIGN 2.2, content only.** Visuals, tokens and `robot-state-visuals.ts` are unchanged:
  - The own lock line has no "expires in N s" countdown: the heartbeats keep the lock alive, so a countdown would be
    misleading.
  - The holder label is `Operator 3f9a`, from the last four hex characters of the `sub`.
  - A simulated robot shows a static "No camera" tile, not a feed or a flat map.
  - A command with no ACK after 5 s shows the REJECT visual with the text "No answer".
- **Viewers see no command controls**, only the lock line.

## Alternatives considered

| Option                               | Pros                           | Cons                                                                            | Why not                                                                         |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Commands in the TanStack Query cache | One state tool for the console | An ACK is a live frame, not a fetched resource; refetch semantics would drop it | SPEC 4.4 puts real-time state in Zustand                                        |
| Confirm the e-stop as well           | No accidental stop             | Every second of a safety stop waits for a click                                 | An accidental stop is safe and recoverable; a confirmed release is not          |
| Retry the lock race in the cloud     | The console does less          | The robot's answer is seen only by the console                                  | The retry needs the answer, so it lives where the answer arrives                |
| Poll the lock every few seconds      | No store to keep               | Stale for seconds; the frames already exist                                     | `lock.changed` and `robot.event` carry the change                               |
| Browser `confirm()` for the release  | No markup to write             | Blocks the page and cannot take the design's styling or focus order             | An in-panel dialog keeps keyboard and screen reader behaviour under our control |
| Show a countdown on the own lock     | Operator sees the time left    | The heartbeats keep it alive, so the number is wrong most of the time           | Deviation recorded above; the lock state is the signal                          |

## Consequences

- The e-stop path has no wait in the console. A press produces one HTTP request and one visible state at once.
- If the socket is down, sent commands stay pending until the 5 s timer and then show "No answer", while the cloud may still
  have published them. The robot's own state arrives through the fleet state, and the log shows the uncertainty honestly.
- The stores hold command ids, robot ids, times and statuses only. No token, no key and no e-mail reaches them (T59).
- The holder label shows part of a `sub`, so it identifies an operator to a colleague but not to the outside (R86).
- The design deviations above are the only changes to DESIGN 2.2 in M9. Any further visual change needs a new ADR.
