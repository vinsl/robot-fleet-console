# ADR 0057 — Console live fleet state: one reducer, protocol ordering, silence and reconnect rules

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-ROB-3, FR-ALR-1, NFR-REL-1, NFR-PERF-1, NFR-A11Y-1
- Threat: T41 (token in the connection URL), R81 (frames of another site), R82 (snapshot size)
- Implemented in: `apps/console/src/live/fleet-reducer.ts`, `apps/console/src/live/fleet-selectors.ts`,
  `apps/console/src/live/fleet-store.ts`, `apps/console/src/live/frame-site.ts`, `apps/console/src/live/alerts-feed.ts`,
  `apps/console/src/api/alerts.ts`, `apps/console/src/ws/ws-client.ts`, `apps/console/src/app/create-services.ts`,
  `packages/protocol/src/live-order.ts`, `services/api/src/domain/live/state-order.ts`

## Context

Until M8 the console opened the WebSocket and only marked the time of the last message. It kept no robot data and no
alert list. M8 needs a live map, a robots list, KPIs and an alert feed, all fed by the same stream. Three forces apply.
The stream has no replay: the API sends a snapshot only in answer to a `subscribe`, so a reconnection must subscribe
again. Messages can arrive out of order across a reconnection, so the console must apply the same ordering rule as the
API. And the console can be the party that is disconnected: painting every robot OFFLINE in that case would show a
false fleet state and hide the real problem, which is the connection.

## Decision

- **One store for real-time data.** `fleet-store.ts` (Zustand) holds the robots, the session log and the snapshot
  time. A pure reducer (`fleet-reducer.ts`) applies one server frame, and `create-services` feeds it from `onMessage`.
  Selectors compute the displayed state, the staleness and the badges from an injected clock.
- **Alerts stay server state.** They live in the TanStack Query cache under `alerts`. Frames patch that cache
  (`alerts-feed.ts`); they do not create a second copy in Zustand.
- **Ordering is a protocol rule.** `isNewerSample` (boot identifier, then sequence) moves to
  `packages/protocol/src/live-order.ts`. The API module delegates to it, and the console imports it. The rule is not
  copied.
- **Silence applies only while the socket is open.** While the connection is open, a robot silent for
  `OFFLINE_SILENCE_MS` (15 s) is shown OFFLINE, and it is stale from `map.staleAfterMs`. While the connection is closed
  or reconnecting, markers keep their last state with the stale badge, and the robots-online count shows "no data".
- **Reconnection re-subscribes.** On every `open`, the client sends `subscribe` (the server answers with the snapshot),
  then invalidates the alert queries. A keep-alive `ping` is sent every `pingIntervalMs` (5 min) while open.
- **Frames of another site are dropped** on the client (`frame-site.ts`), in addition to the server-side subscription
  check. The demo runs one site.
- **The snapshot is capped by the protocol** (`SNAPSHOT_MAX_ROBOTS`, 60). A robot beyond the cap is not shown and is
  counted in `droppedRobots`, which the robots sheet displays. The cap is a display limit, not a security control (R82).

## Alternatives considered

| Option                                              | Pros                | Cons                                                                                     | Why not                                                                             |
| --------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Alerts in the Zustand store too                     | One state container | Two copies of server data to keep in step; the query cache already refetches and retries | SPEC 4.4 assigns server state to TanStack Query and real-time state to Zustand      |
| Copy `isNewer` into the console                     | No protocol change  | Two implementations of the ordering contract                                             | "Never duplicate a schema" (repository rules); the ordering is part of the protocol |
| Resume after reconnection without a snapshot        | Less traffic        | Missed samples and state changes stay wrong until the next delta                         | The API sends a snapshot only on `subscribe`; the snapshot is the recovery          |
| Apply the 15 s silence rule whatever the connection | Simple, one rule    | Paints a healthy fleet OFFLINE while the console is offline                              | Hides the real problem (the connection)                                             |

## Consequences

- The console never shows a robot OFFLINE for a connection gap. It shows a stale marker and "no data" for the count.
  This is a display choice with a known limit: a robot that really stopped during the gap is shown as OFFLINE only
  after the connection is back and the snapshot or the first silence check arrives.
- Alerts missed during a gap come back with the reconnection refetch, or with the 60 s refetch at the latest.
- A new frame type needs a reducer case and a test in `fleet-reducer.test.ts`; unknown frames return the same object.
- The client keeps the ordering rule of the API, so both sides drop the same stale samples.
- No cost change: the same WebSocket and the same HTTP calls as the rest of the console.
