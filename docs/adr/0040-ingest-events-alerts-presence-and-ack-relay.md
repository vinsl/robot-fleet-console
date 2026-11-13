# ADR 0040 — Ingest events: alerts, presence and command acknowledgement relay

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ALR-1, FR-ALR-2, FR-CMD-5, FR-ROB-3, FR-KPI-1, NFR-REL-1
- Threats: T33 (alert flood), T31 (ingest identity), T32 (late samples), R28 (connect_failed presence), R46 (no silence sweep)
- Builds on ADR 0031 (events function and rules), ADR 0038 (state writes) and ADR 0039 (telemetry consumer).

## Context

`ingest-events` receives the QoS 1 events of the robot, its command acknowledgements and the broker's presence
notices (ADR 0031). SPEC 4.3 gives both ingest functions a share of the alerts: telemetry is QoS 0, and two writers
for the same condition would raise it twice. FR-ALR-1 lists a "late mission" alert, but no protocol event says that a
mission is late. KPI needs the mission completions, and the robot page needs a timeline of states.

## Decision

- **One owner for alerts.** `ingest-events` opens alerts, and only from QoS 1 events and presence. The telemetry
  consumer raises none. The kinds are `ESTOP` (Critical, on a state change to ESTOP), `BLOCKED` (Major, on a state
  change to BLOCKED), `LOW_BATTERY` (Minor, on a `BATTERY_LOW` fault) and `OFFLINE` (Major, on an unclean presence
  disconnect). `late mission` is not implemented in M5.
- **Opening an alert is one transaction.** It puts the alert in the events table and a marker
  `ALERTOPEN#<robotId>#<kind>` in the fleet table, both with `attribute_not_exists`. The client request token is the
  alert id, so a repeated transaction within DynamoDB's idempotency window is the same transaction. The alert id is the
  first 32 hexadecimal characters of the SHA-256 of robot, kind and source message, so a redelivery maps to the same
  alert. The outcome is `OPENED`, `DUPLICATE` (this message already stored its alert) or `ALREADY_OPEN` (a marker is
  present: no second alert of that kind for that robot, metric `AlertDeduplicated`). The M8 alerts function deletes the
  marker when an alert is resolved; the marker contract is written here, the function is not built yet.
- **History.** A `STATE` item (7 days) for each state change and a `MISSION` item (30 days) for each `WORK_DONE` that
  leads to `IDLE`. Both are conditional puts: a duplicate is success.
- **Presence.** A `connected` notice marks the robot ONLINE, and relays `robot.presence ONLINE` only when the write was
  applied. A `disconnected` notice marks it OFFLINE through the presence version. It opens the OFFLINE alert unless the
  robot said `GOING_OFFLINE` for the same boot and the disconnect was client initiated (a clean shutdown). A
  `connect_failed` notice writes nothing, opens nothing and relays nothing, because its client id may belong to
  another robot (R28). A notice for a robot without a claim is counted (`PresenceUnknownRobot`) and dropped.
- **Relay.** `robot.event`, `alert.changed` and `robot.presence` go to every subscribed connection of the site.
  `command.ack` goes to Admin and Operator only: it carries the command identifier of an operator's action, and a
  Viewer is read-only.
- **Order.** The durable writes come first, the relay last. A relay never throws: a failed push is counted.
- **No idempotency table.** The design listed one. None of the M5 effects needs Powertools idempotency, because each
  write is conditional on a message identifier or a marker. The table is not created; it returns with M9 if the
  commands need it.

## Alternatives considered

| Option                               | Pros                       | Cons                                                  | Why not                                               |
| ------------------------------------ | -------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Telemetry also raises alerts         | Alerts on the QoS 0 stream | Two writers, duplicates, flapping from a lossy stream | One owner (SPEC 4.3 read as one writer per condition) |
| Query open alerts, then insert       | Simple code                | Not atomic: two deliveries can both insert            | The transaction with a marker is atomic               |
| Alerts from a rule or Step Functions | Declarative                | Another service and another writer                    | The events function already owns the events           |
| Relay acknowledgements to every role | Simpler audience           | A Viewer learns the operator's command identifiers    | Audience chosen by the protocol (least information)   |

## Consequences

- **Until M8 resolves alerts, the marker stays.** A robot that opens a BLOCKED alert and is blocked again gets no new
  alert (`ALREADY_OPEN`), and the same holds for OFFLINE after a reconnect and a second disconnect. The console shows
  the open alert, and M8 deletes the marker on resolve. This is the main limit of M5 and is stated in the README.
- An alert write costs two write units (the transaction), at most a few per incident.
- KPI availability counts only the presence-based OFFLINE (THREAT_MODEL R46): a silent robot is not counted.
- Relayed frames are validated by `WsServerMessageSchema` before they are sent, so a bad stored record cannot reach
  a console.
