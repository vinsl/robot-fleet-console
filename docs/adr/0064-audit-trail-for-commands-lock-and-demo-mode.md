# ADR 0064 — Audit trail for commands, lock and demo mode, read through the status index

- Status: accepted. Amended by ADR 0077 (the audit read takes the robot and result filters)
- Date: 2026-11-04
- Requirements: SEC-LOG-1, SEC-API-2, FR-CMD-5, FR-DEMO-1, FR-AUTH-1
- Threat: T56, R83, R84, R86, R93
- Implemented in (planned, M9): `services/api/src/adapters/dynamodb-audit.ts` (`auditItem`, `DynamoDbAuditReader`),
  `services/api/src/domain/control/audit.ts`, `services/api/src/domain/audit/list-audit.ts`,
  `services/api/src/handlers/audit.ts`, `packages/protocol/src/audit.ts`, `packages/protocol/src/audit-api.ts`,
  `infra/envs/demo/audit.tf`, `infra/envs/demo/tests/audit.tftest.hcl`

## Context

SPEC 4.4 asks for an audit view with who did what, when, the result and the correlation id. M8 writes audit records
for the alert lifecycle in the same transaction as the change (ADR 0061). M9 adds the commands, the lock and the demo
flag, which are the actions an operator can be held to. Three facts shape the decision:

- The audit records live in the `events` table, partitioned by `SITE#{siteId}`, next to telemetry states and missions.
  At 20 robots that partition holds about 2 400 items per hour. A query on it for the audit rows would read the states
  and discard them, and a `Limit` applied before a filter returns short pages.
- An audit write can fail. If the audit write sits in front of an e-stop, an audit outage delays a safety stop.
- A command is published to a robot outside any database transaction, so the publish and the audit record cannot be
  atomic.

## Decision

- **New actions**: `lock.acquire`, `lock.release`, `command.pause`, `command.resume`, `command.return_to_base`,
  `command.estop`, `command.estop_release`, `command.simulate_fault`, `demo.enable`, `demo.disable`. The record gains an
  optional `commandId`, present exactly on the `command.*` actions. The robot refinement names the robot for the
  `robots.`, `alert.`, `command.` and `lock.` prefixes, and no robot for `site.` and `demo.`.
- **Results**: `SUCCEEDED` when the change or the publish happened, `REFUSED` for every refusal after authentication
  (role, site, lock, demo mode or conflict), `FAILED` when the publish or a store call failed after the request was
  accepted. The problem code is carried in the record.
- **Written after the outcome, best effort.** A failed audit write increments `AuditWriteFailed`, logs the same facts and
  does not change the response. Commands are not held for the audit.
- **E-stop publishes first, then audits.** An audit outage never delays an e-stop. The log line carries the same
  correlation id and command id, so the record can be rebuilt.
- **Read path through the status index.** `auditItem()` writes `openAlertPk = SITE#{siteId}#AUDIT` and
  `openAlertSk = {ts}#{auditId}` on every audit record, so one write feeds the alert, the site and the robot audit. The
  sparse `openAlerts` index (ADR 0061) gets this third partition. No table or index is added.
- **`GET /sites/{siteId}/audit`** is open to every role. It returns the newest records first, with `limit` from 1 to 100
  (default 50) and an opaque cursor: base64url of `{ts, auditId}`, decoded by a strict schema, that must produce a key in
  the `SITE#{siteId}#AUDIT` partition.
- **Who is shown.** The record carries the actor `sub`. The API returns it to every role (R86, accepted). The console shows
  only the last four hex characters of the `sub` (`Operator 3f9a`).
- **Audit records written before M9 are not listed** by the new read, because they were not written to the new partition
  (R93, accepted: the demo stack holds only test alerts from M8).

## Alternatives considered

| Option                                           | Pros                                       | Cons                                                                                   | Why not                                                                       |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Query the base partition with a filter           | No new partition                           | Reads about 2 400 state and mission items per hour to find the audit rows; short pages | A status index gives a sorted read of audit rows only                         |
| Audit before the effect                          | The record exists even if the effect fails | An audit outage delays or blocks an e-stop                                             | An e-stop must never wait for a second write (T56 is met by the logs)         |
| A separate audit table                           | Clean read path                            | A table, IAM and Terraform for one record type                                         | The index needs no table change; the TTL of 365 days is already on `events`   |
| A new GSI on the `events` table                  | Name matches the content                   | A table update and a replacement risk on a live table                                  | The sparse index is overloaded in the same way ADR 0061 documents             |
| Audit the robot ACK                              | The robot's answer is recorded             | The ACK is a live frame; the cloud decision is what the operator did                   | R83: the audit result is the cloud decision; the ACK is live only             |
| Put the publish and the audit in one transaction | Atomic record                              | Publish is not a DynamoDB operation and cannot join a transaction                      | Atomicity is not reachable; the order (publish, then audit) is chosen instead |

## Consequences

- The audit read is one `Query` on a partition that holds only audit rows, with a bounded page. The cost is one extra
  item write per audited action, which is negligible at demo scale.
- A failed audit write leaves a gap that the logs fill (R84). The gap is visible in the `AuditWriteFailed` metric.
- The audit function has `dynamodb:Query` only on the open-alerts index. No function holds a delete right on the `events`
  table (T56).
- Every role can read the subjects of the audit (R86). The console hides full subjects, but the API does not.
- The record grows by two optional fields. Existing alert and robot records remain valid.
