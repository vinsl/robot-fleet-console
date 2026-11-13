# ADR 0077 — Audit filters as filter expressions on the audit partition

- Status: accepted
- Date: 2026-11-04
- Requirements: SEC-LOG-1, SEC-API-2, FR-CMD-5
- Threat: T10, T56
- Amends: ADR 0064 (the audit read takes two optional filters)
- Implemented in: `packages/protocol/src/audit-api.ts` (`AuditListQuerySchema`),
  `services/api/src/domain/audit/ports.ts` (`AuditPageRequest`), `services/api/src/domain/audit/list-audit.ts`,
  `services/api/src/adapters/dynamodb-audit.ts` (`auditFilter`, `AUDIT_MAX_FILTERED_QUERIES`),
  `apps/console/src/audit/AuditFilterBar.tsx`, `apps/console/src/audit/AuditSheet.tsx`

## Context

The audit sheet lists the records of a site, newest first, one page at a time. An operator who wants every refusal, or
every action on one robot, has to load page after page. The records sit in the `events` partition `SITE#{siteId}#AUDIT`
(ADR 0064), which holds no telemetry, so a query on it returns audit rows only. A DynamoDB `Limit` counts the items it
evaluates before a `FilterExpression` removes the others, so a filtered query can return a short page, or none, while
older matches remain. The read path must stay a single site-scoped query, and the HTTP API already forwards query
parameters, so no infrastructure change is needed. The demo volume is small, and the time budget for this bonus is about
one hour.

## Decision

The audit read accepts two optional query parameters, `robotId` and `result`, validated by strict zod after the role and
site checks. The reader adds them to the existing query on the site's audit partition as a `FilterExpression`, with the
attribute names as expression names and the values as expression values, never in the expression text. Because `Limit`
applies before the filter, the reader repeats the query with the remaining limit and the last evaluated key, for at most
`AUDIT_MAX_FILTERED_QUERIES = 5` queries per page, and never returns more items than the page size. A request without a
filter keeps the single query it runs today. The cursor still holds only a position in the partition. The console keeps
the filters in its query key, and when a filtered page is empty but older records are not yet read, it offers
"Search older records" instead of claiming that no record matches.

## Alternatives considered

| Option                                            | Pros                                                    | Cons                                                                                            | Why not                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Client-side filter on the loaded pages            | No API or protocol change                               | Hides the matches that are not loaded yet; an empty filtered view says nothing about the trail  | The operator would read a false "no refusal" on a long trail                                         |
| Global secondary index by robot (`byRobot`)       | Each filtered query reads only its matches              | Not scoped to the site, so the site check moves into the index keys; new IAM and a table change | Needs an infrastructure change and a second access path for one bonus; the site scope becomes weaker |
| Filter expression on the audit partition (chosen) | One site-scoped query per page, no index, no IAM change | Read cost grows with the trail; a filtered page can take up to five queries                     | Accepted at demo volume, see the consequences                                                        |

## Consequences

- Easier: the operator finds every refusal or every action on one robot without loading the whole trail, and an empty
  filtered result says whether older records remain unread.
- Harder: the reader owns a bounded loop, and the tests must cover the stop conditions (no key, limit reached, five queries).
- Limit: the robot select lists the robots of the live fleet, so a robot that was retired is not selectable. Listing
  the distinct robot ids of the trail is the path if that lookup is needed.
- Residual: DynamoDB reads and bills every item of the partition the filter scans, so the read cost of a filtered page
  grows with the size of the site's trail. At demo volume (about 2 400 items per hour across all robots, per ADR 0064)
  this is acceptable. At scale, the path is the `byRobot` index with a `begins_with` check on the site prefix, as this
  ADR's alternatives table records; that change is not built.
- Security: the filter values reach DynamoDB only as expression values. Each invalid value is refused with a fixed
  problem text, and the value is not echoed. The partition comes from the verified site, never from the request. Any role
  can read the trail, as before, so the filters widen no access. IAM is unchanged.
