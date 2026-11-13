# ADR 0043 — Real-time protocol schemas live in `packages/protocol`

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-RT-1, FR-MAP-1, FR-ALR-1, NFR-PERF-1, SEC-WS-1

## Context

M5 adds the WebSocket channel, the live fleet state, alert records and the site map. The console (M6, M8), the
ingest functions (M5) and the simulator (M5, Python) all read or write these shapes. the repository rules allows one home for
schemas, `packages/protocol`. API Gateway limits a WebSocket frame to 32 KB, and the console must keep working when
the fleet grows past what one frame can carry.

## Decision

The WebSocket messages, `RobotLiveState`, `AlertRecord` and the GeoJSON site map are zod `strictObject` schemas in
`packages/protocol`, with JSON Schema artifacts generated from them. Server frames are capped at 30 000 bytes: the
caps on robots per `fleet.snapshot` (60) and per `fleet.delta` (70) are measured on worst-case frames by tests, and a
larger fleet receives several snapshot frames. Alert invariants (`acknowledgedAt` and `resolvedAt` not before
`openedAt`) are part of the schema. The site map parser checks the size first, then JSON, then the schema, and
refuses with a fixed message that never echoes the input.

## Alternatives considered

| Option                            | Pros                                  | Cons                                        | Why not                                    |
| --------------------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Schemas next to each consumer     | Smaller change per milestone          | Three copies drift apart                    | Breaks the one-schema rule                 |
| Caps of 100 and 200 robots        | Fewer frames                          | A worst-case frame exceeds the 32 KB quota  | The schema would accept frames never sent  |
| Python mirror of the site map now | Simulator reads the same corpus entry | Corpus parity test forces a pydantic mirror | The simulator reads the TS fixture by path |

## Consequences

M6, M7 and M8 import one contract, and a change needs a protocol PR first. The sample site map and its invalid cases
live in `packages/protocol/test/fixtures/site-map/`, outside the corpus that the Python parity test mirrors. The
robot radius of 0.4 m used by the clearance test comes from the planner decision (ADR 0042, M5 PR-5). No cost.
