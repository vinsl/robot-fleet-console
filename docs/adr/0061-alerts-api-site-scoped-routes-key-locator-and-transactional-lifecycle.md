# ADR 0061 — Alerts API: site-scoped routes, key locator, strict lifecycle and transactional audit

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-ALR-2, FR-AUTH-1, SEC-API-1, SEC-API-2, SEC-API-3, SEC-IAM-1, SEC-LOG-1, FR-SITE-1
- Threat: T33, T46, T47, T48, T49, R47 (closed by this ADR), R75, R76, R77, R79, R80
- Numbering: the design reserved 0056 for this decision. 0056 was taken by the workstation footprint ADR (M7) before
  this one was written, so the alerts API is 0061. The four comments in `services/api/src/domain/alerts/` that cite
  "ADR 0056" must read "ADR 0061".
- Implemented in: `packages/protocol/src/alerts-api.ts`, `packages/protocol/src/audit.ts`,
  `services/api/src/domain/alerts/*.ts`, `services/api/src/adapters/dynamodb-alert-store.ts`,
  `services/api/src/adapters/dynamodb-alerts.ts`, `services/api/src/handlers/alerts.ts`,
  `infra/envs/demo/alerts.tf`, `infra/envs/demo/api.tf`

## Context

Robots raise alerts (ESTOP, BLOCKED, OFFLINE, LOW_BATTERY) and the ingest function opens them (ADR 0040). M8 lets an
operator acknowledge and resolve them, and lets every role read the active list and the last 24 hours of resolved
alerts. Four forces shape the design:

- Every site route since M7 is `/sites/{siteId}/...` (ADR 0047, multi-site ready). The SPEC row `/alerts` is corrected to
  the same shape.
- An alert is a change of state that somebody must answer for, so the transition and its audit record must commit
  together (SEC-LOG-1, repudiation T48).
- The resolve must delete the robot's marker, otherwise the robot never gets a second alert of that kind (R47).
- The resolved history must be read without scanning the site partition, which holds about 2 400 state items per hour at
  20 robots.

## Decision

- **Routes per verb.** `GET /sites/{siteId}/alerts` (Admin, Operator, Viewer) with `status=active|resolved`, `severity`,
  `robotId`, `since` (resolved only), `limit` 1–100 and an opaque `cursor`. `POST .../alerts/{alertId}/acknowledge` and
  `POST .../alerts/{alertId}/resolve` (Admin, Operator) with the body `{ "openedAt": IsoMs }` only. Each route has its
  own throttle. The query and the body are strict, so an unknown field is refused and no field can be set by the client.
- **Key locator.** The path `alertId` and the body `openedAt` build the exact sort key of the alert. The read is strongly
  consistent. A mismatch is a 404. The GSI is not used to find an alert, because it is eventually consistent.
- **Strict lifecycle.** Acknowledge only from OPEN; resolve only from ACKNOWLEDGED. Repeating the action on an alert
  already in its target state returns 200 with `changed: false`, and writes nothing. Any other wrong state is a 409
  `alert-state-conflict`, audited as REFUSED on a best-effort basis.
- **One transaction per transition.** `TransactWriteItems` holds the conditional update of the alert, the conditional
  delete of the marker (on resolve only, conditional on the alert id), and the conditional put of the audit record. The
  `ClientRequestToken` is the audit id, so an SDK retry cannot write twice. A cancellation on the marker is handled by a
  second transaction without the marker, and the mismatch is counted.
- **Actor and time are server values.** The actor is the verified `sub` of the access token. The time is the server
  clock, never before the opening.
- **Live update by direct fan-out.** After a committed transition, the function sends `alert.changed` (ACKNOWLEDGED or
  RESOLVED) to every role through the existing fan-out, in reliable mode. It does not use a stream.
- **Resolved history in the status index.** On resolve the alert moves to the partition `SITE#{siteId}#RESOLVED` of the
  existing sparse `openAlerts` index, with the sort key `{resolvedAt}#{alertId}`. The index keeps its name, which is now
  a misnomer, and no table or index is added.
- **Cursors are opaque and checked.** A cursor is a base64url JSON pair of the base sort key and the index sort key. It
  is decoded by a strict schema. The partitions are rebuilt from the verified site and the requested status, never
  from the cursor. Any mismatch is a 400.

## Alternatives considered

| Option                                             | Pros                         | Cons                                                                                         | Why not                                                                                            |
| -------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PATCH /alerts/{id}` with a `status` body          | One route                    | A body that sets a state is a mass-assignment surface (T47); one throttle for two actions    | One route per verb: one role row and one throttle each                                             |
| Find the alert through the `openAlerts` GSI        | No `openedAt` in the body    | Eventually consistent: a new alert can be missing for a moment; more reads                   | Strongly consistent `GetItem` by the key the caller already has                                    |
| Update the alert, then write the audit best effort | Matches the site pattern     | A transition can exist without its record (T48); a crash between the two leaves the marker   | One transaction keeps the record and the change together                                           |
| Allow resolve from OPEN                            | Fewer steps for the operator | The record of who acknowledged would be missing on some resolved alerts                      | FR-ALR-2 and demo step 6 name acknowledge then resolve                                             |
| DynamoDB stream on `events` to a relay function    | No call in the API           | A new stream, a function, a DLQ and IAM for one message                                      | The fan-out code already exists; the console refetches the lists every 60 s, so a lost frame heals |
| New GSI for resolved alerts                        | Name matches the content     | A table update in Terraform, a replacement risk for a live table, and a second index to keep | The overloaded sparse index needs no table change; the cost is the name                            |

## Consequences

- Each transition is one write of a few items, and each list page is one Query call, so the cost stays at cents a month
  at demo scale (about 1 million read units a month at most).
- The marker is deleted in the same transaction as the resolution (**closes R47**). The next BLOCKED, OFFLINE,
  LOW_BATTERY or ESTOP of that robot opens a new alert.
- The alerts function role reaches the whole `SITE#<id>` partition of the events and fleet tables, because IAM leading
  keys cannot restrict the sort key (R79, accepted). The code touches only the alert item, its audit record and the
  alert marker. Role and site are enforced in the handler before any store call, and the policy is pinned by
  `infra/envs/demo/tests/alerts.tftest.hcl`.
- A list page can be short or empty while a cursor is returned, because the page limit applies before the filter (R75).
  The console follows the cursor, and the cost stays bounded by the limit.
- The name `openAlerts` now covers resolved alerts. The SPEC row for the index says so.
- A resolution does not check that the robot condition has cleared, and nothing resolves an alert automatically (R77).
  Auto-resolution is a next step, not part of this ADR.
- The alerts function is synchronous: retries 0, no DLQ, timeout 5 s, 256 MB.
