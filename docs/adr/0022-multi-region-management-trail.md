# ADR 0022 — Multi-Region management-events audit trail

- Status: accepted
- Amended by: ADR 0024
- Date: 2026-10-31
- Requirements: SEC-LOG-1, SEC-IAM-1, NFR-COST-1

## Context

SEC-LOG-1 requires CloudTrail management events. The deploy role must not be able to weaken that record: it
cannot stop the trail, delete it, update it or change its event selectors (THREAT_MODEL R15, ADR 0020). IAM and
STS calls are global, and a single-region trail outside us-east-1 does not receive them. Log storage is billed,
and CloudWatch Logs ingestion is billed too, while the project targets 0 € (NFR-COST-1). A read-only check on
2026-10-31 found no trail in the account, so this stack creates the first one.

## Decision

- One trail, `mfc-demo-trail`, homed in the stack region, with `is_multi_region_trail = true`,
  `include_global_service_events = true`, `enable_log_file_validation = true` and `enable_logging = true`.
- No event selector, advanced event selector or insight selector. The default records every management event.
- The logs go to a private bucket named `mfc-demo-trail-<bucket_suffix>`: the four public access blocks are on,
  ownership is `BucketOwnerEnforced`, versioning is enabled, and the default encryption is SSE-S3 (AES256). The
  bucket policy lets only this trail's ARN (`aws:SourceArn`) write `AWSLogs/<account>/*` with
  `bucket-owner-full-control`, and denies requests without TLS and with TLS below 1.2.
- Lifecycle: current log objects expire after 90 days, noncurrent versions after 30 days.
- No customer-managed KMS key, no CloudWatch Logs delivery and no SNS notification per delivery.
- The bucket keeps the `mfc-demo-trail-` prefix, which the deploy role's read-only denial matches (ADR 0020, ADR 0024).
  `force_destroy` is set, so `make destroy` can empty the bucket from the owner's session. A CI destroy cannot.

## Alternatives considered

| Option                                  | Pros                                       | Cons                                                                       | Why not                                                                      |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Single-region trail in the stack region | Smaller configuration                      | Misses IAM and STS events outside us-east-1                                | The IAM and STS changes are the ones that matter most for this threat model  |
| Organization trail                      | Covers every account of an organization    | The stack manages one account and no organization                          | `is_organization_trail` stays false                                          |
| CloudWatch Logs delivery                | Queryable events, a base for metric alarms | Ingestion is billed; no alarm needs it before M10                          | Kept off for cost (NFR-COST-1); M10 can add it with its own ADR              |
| Data events or Insights                 | More detail                                | Billed per event; the deploy role is denied `PutEventSelectors`            | Outside the 0 € target                                                       |
| Customer-managed KMS key                | Key control and key policy                 | About 1 € per key per month (THREAT_MODEL R2); SPEC section 11 excludes it | AWS-managed SSE-S3 is enough for management-event evidence in this demo      |
| Trail changed by CI                     | No manual step                             | CI could then weaken the record it is supposed to protect                  | Changes come from the owner's session and from code in the same pull request |

## Consequences

- The trail records IAM, STS and every other management event from every Region. Log file validation makes
  an edited or removed log file detectable.
- Any change to the trail other than tags and `StartLogging` needs the owner's SSO session and a code change in the
  same pull request. The deploy role is denied `CreateTrail`, `UpdateTrail` and `PutEventSelectors` (ADR 0024).
- The bucket holds the log files, billed as storage and PUT requests. The estimate is in `docs/COSTS.md`.
- The deploy role cannot create, change or empty the trail bucket, nor create the trail (ADR 0024); those changes
  come from the owner's session.
- The first copy of management events is free. Evidence older than 90 days is gone by design.
