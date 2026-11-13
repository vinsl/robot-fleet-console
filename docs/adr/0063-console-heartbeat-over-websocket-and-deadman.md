# ADR 0063 — Console heartbeat over the WebSocket: server-side check, silent refusals and the hidden tab

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-CMD-2, FR-CMD-3, SEC-API-5, SEC-CMD-1
- Threat: T55, R85, R91
- Implemented in (planned, M9): `services/api/src/domain/ws/heartbeat.ts`, `services/api/src/domain/ws/dispatch.ts`,
  `services/api/src/domain/ws/metrics.ts`, `services/api/src/handlers/ws-message.ts`,
  `apps/console/src/control/use-heartbeat.ts`, `packages/protocol/src/ws.ts`

## Context

The robot stops if it does not hear the lock holder for 1 s (ADR 0028, the deadman). FR-CMD-3 asks for a console
heartbeat every 250 ms over the WebSocket while the operator holds control. The robot only listens to MQTT, and the
browser only talks to the WebSocket, so the cloud has to turn each heartbeat into a robot command. Three facts
constrain the design:

- A heartbeat at 4 Hz is the most frequent message in the system. An error frame for each refusal would flood the socket,
  and the WebSocket limit of 10 frames per second closes a flooding connection (ADR 0041).
- The console holds the lock only as long as the operator's session is alive, so the cloud must check the lock itself on
  each heartbeat. A client claim of "I hold it" is not evidence.
- Browsers throttle timers in background tabs to about one tick per second.

## Decision

- **The console sends `{ type: "heartbeat", robotId }` every 250 ms** while its lock state for that robot is `mine`. The
  frame carries no token. It stops when the lock is released, when the tab is unmounted, and when the state changes.
- **`ws-message` checks, in order:** the connection role (Admin or Operator; a Viewer gets `error FORBIDDEN_ROLE` through
  the existing refuse path), the site from the stored connection record, then a strongly consistent read of the lock
  item. It publishes `HEARTBEAT` on the robot's `cmd` topic only if the lock holder equals the connection `sub` and the
  lock has not expired. The cloud refreshes `expiresAt` at most every 10 s (ADR 0062).
- **Every other refusal is silent.** It increments `HeartbeatRefused` and logs at most once per second. The console learns
  the lock state from `lock.changed` and `robot.event` frames, not from heartbeat replies.
- **A publish failure never throws.** It increments `HeartbeatPublishFailed`. The robot's deadman then pauses the robot,
  which is the fail-safe direction.
- **Hidden tab.** Browsers slow timers in a hidden tab, so the tab stops feeding the deadman and the robot pauses about one
  second later. This is kept on purpose: an operator who cannot see the tab must not keep a robot moving. The console
  shows "Control link lost, the robot pauses in 1 s" when the socket is down, and the README states the rule.
- **The lock is not capped in time while heartbeats run.** An active tab keeps the lock with no absolute limit. The
  30 s expiry applies only when the heartbeats stop.

## Alternatives considered

| Option                                          | Pros                                         | Cons                                                                                  | Why not                                                                   |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| An error frame for each refusal                 | The console knows why a heartbeat failed     | 4 frames per second per operator; the 10 frames per second limit closes the socket    | Refusals are normal (no lock, lock lost); silence is the signal           |
| Heartbeat by HTTP `POST` every 250 ms           | Same path as commands                        | 4 requests per second, a Lambda invocation each, and the API latency on a safety path | The socket already exists and is authenticated                            |
| Web Worker timer, so a hidden tab keeps ticking | The robot does not pause in a background tab | A worker would keep driving a robot from a tab the operator cannot see                | A fail-safe pause is preferred to motion nobody watches                   |
| Refresh the lock on every heartbeat             | The expiry tracks the heartbeat exactly      | 4 writes per second for nothing; the robot refreshes its own copy on every heartbeat  | At most one refresh per 10 s keeps the lock alive with a 30 s margin      |
| Trust the client's "I hold the lock" flag       | No lock read on the socket                   | A forged or stale client state could feed the deadman of a robot held by someone else | T55: the cloud checks the holder against the verified connection identity |

## Consequences

- While a lock is held, each operator costs about 4 socket messages, 4 strongly consistent reads and 4 publishes per
  second. The reads and publishes are small. The lock read is the cost to watch in `docs/COSTS.md`.
- A cold start of `ws-message` longer than 1 s pauses the robot (R85). This is accepted as the fail-safe direction.
- A tab that keeps sending heartbeats keeps its lock until the operator releases it, and an Admin cannot force-release
  it (R91). The lock stays visible to every role with the holder label, so the others can see who holds it.
- Monitoring relies on the `HeartbeatRefused` and `HeartbeatPublishFailed` metrics and on the once-per-second log, not on
  per-message logs, so a failure is visible without flooding the logs.
- The browser keeps no timer state outside the component. The deadman is therefore only as good as the open tab, and the
  UI says so.
