# ADR 0024 — Trail bucket read-only to CI, and account-level S3 Block Public Access

- Status: accepted
- Date: 2026-11-01
- Requirements: SEC-LOG-1, SEC-IAM-1, NFR-COST-1

## Context

The deploy role `mfc-demo-gha-deploy` (ADR 0020) could still alter the audit evidence. The deploy-data policy
granted `s3:*` on `mfc-demo-*`, which matches the trail bucket `mfc-demo-trail-<suffix>`, and the only denies on
it stopped object deletes. CI could therefore change the bucket policy, lifecycle and versioning, and overwrite
objects, and the workload boundary covered the bucket through the same pattern (THREAT_MODEL R15). CI could also
create a second trail, or recreate the demo trail with delivery to a bucket of another account, because
`cloudtrail:CreateTrail` was allowed on `trail/mfc-demo-*`. The account had only bucket-level Block Public Access
settings, which do not cover buckets created later; CIS AWS Foundations control 2.1.4 (Security Hub control S3.1)
asks for the account-level setting.

## Decision

- **The trail bucket is read-only to CI, except its tags.** `DenyTrailBucketChangesExceptTags` in
  `mfc-demo-deploy-data` denies every action on the bucket and its objects except `s3:Get*`, `s3:List*`,
  `s3:PutBucketTagging`, `s3:TagResource` and `s3:UntagResource`. It is a `NotAction` deny, so an action that AWS
  adds later is denied too. The tag actions stay because the AWS provider (6.23 and later) tags buckets through
  S3 Control and falls back to `PutBucketTagging`. The workload boundary denies `s3:*` on the bucket and its objects
  (`DenyTrailBucket`), so no workload role can reach it. CloudTrail writes as a service principal, which a boundary
  does not govern.
- **CI does not create the trail.** `cloudtrail:CreateTrail` is removed from the Allow and denied on `*` in
  `DenyAuditTrailChanges`. CI keeps `StartLogging`, `AddTags` and `RemoveTags`, on `trail/mfc-demo-trail` only,
  so that it can restart a trail stopped by hand. This removal was approved by the owner on 2026-11-01.
- **Account-level S3 Block Public Access** is set in `infra/bootstrap/account.tf`, with the four flags true and
  `prevent_destroy`. The deploy role is denied `s3:PutAccountPublicAccessBlock` on `*`, because the same action
  authorises the delete of the setting. No S3 Allow may take `Resource "*"`; a test pins that.
- **The state bucket administration deny is a `NotAction`, and it moves to `mfc-demo-deploy-data`.**
  `DenyStateBucketAdministration` was an enumerated list in `mfc-demo-deploy-core`. The list left Object Lock,
  Notification, Logging, IntelligentTiering and Abac on the state bucket allowed to CI (found in the security
  review; THREAT_MODEL R10). The deny is now a `Deny` of `NotAction [s3:Get*, s3:List*]` on the state
  bucket ARN, so every bucket-level action except the reads is refused, including the ones AWS adds later. The three
  Delete* names of the former list (`s3:DeleteBucketPublicAccessBlock`, `s3:DeleteBucketOwnershipControls` and
  `s3:DeleteBucketEncryption`) need no entry: IAM does not authorise them with their own names, and the Put* actions
  cover those APIs.
- **The two values shared with `modules/audit-trail`** (the trail ARN and the bucket patterns) are locals in
  `infra/bootstrap/policies.tf`, so that they are changed in one place.
- **Process exception, approved by the owner on 2026-11-01.** CI no longer manages the trail bucket. Changes to
  `infra/modules/audit-trail` (the trail, its bucket and their settings, and recreating them after `make destroy`)
  are applied from the owner's SSO session with `terraform -chdir=infra/envs/demo apply -target=module.audit_trail`.
  This is an explicit exception to the rule that infrastructure reaches AWS only through the CI deploy workflow,
  and it covers that module only (ADR 0022 already made it for the trail itself). PR C itself changes only comments in
  `infra/modules/audit-trail`, so no `-target` apply is needed for it.
  - Scope: any change whose plan creates, updates or replaces anything in `module.audit_trail` other than its tags,
    including the recreation of the trail after `make destroy`. That includes the variables
    `bucket_suffix` and `region`, the module inputs, `name_prefix`, and a provider bump that changes a diff. It is
    not limited to edits under `infra/modules/audit-trail`.
  - Procedure: apply only after `reviewer` and `security-reviewer` passed on the final commit, and record that commit
    SHA in the PR. The apply runs from the PR branch before the merge, so that the deploy after the merge is a no-op.
    If the PR is not merged, revert with the same `-target` apply from `main`.
  - The bootstrap, which holds the account setting, is applied from the owner's session after the merge, as before.

Tests: `audit_trail_and_state_denies_hold`, `trail_bucket_is_read_only_to_ci`, `ci_manages_only_the_demo_trail` and
`account_blocks_s3_public_access` in `infra/bootstrap/tests/iam.tftest.hcl`.

## Alternatives considered

| Option                                                      | Pros                                     | Cons                                                                                                                                          | Why not                                                                 |
| ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Enumerated deny list on the trail bucket                    | Short, the same form as the state bucket | Misses actions that AWS adds later and indirect paths: an overwrite whose noncurrent version expires, replication                             | `NotAction` keeps only the reads and tags a refresh needs               |
| Narrow `CreateTrail` to `trail/mfc-demo-trail`              | CI keeps a create path for a rebuild     | `CreateTrail` has no condition key on the bucket, so a recreated trail could deliver to another account                                       | Denied; a rebuild after `make destroy` is done from the owner's session |
| Move `modules/audit-trail` into the bootstrap root          | No CI exception to document              | A state move across two roots (`removed` in `envs/demo`, `import` in bootstrap) and a change of smoke outputs, two days before the checkpoint | Deferred; revisit when the trail module changes more than once          |
| Bucket-level Block Public Access only (the previous state)  | No change                                | Does not cover buckets created later; CIS 2.1.4 and Security Hub S3.1 ask for the account setting                                             | Account-level setting added; bucket-level settings kept                 |
| Rely on the implicit deny for `PutAccountPublicAccessBlock` | No statement to maintain                 | A future Allow on `*` would grant the action without review                                                                                   | Explicit Deny, plus a test that no S3 Allow takes `Resource "*"`        |

## Consequences

- A change that CI attempts on the trail bucket, or a `CreateTrail`, is refused with AccessDenied. This fails closed.
- CI still reads the trail objects and changes the bucket's tags. No policy uses S3 tags (the only
  `aws:ResourceTag` conditions are on Cognito user pools), and the bucket's ABAC stays off because `s3:PutBucketAbac`
  is denied. This is the Low residual of THREAT_MODEL R15.
- Changes to the trail module, and its recreation after `make destroy`, depend on a human step from the owner's SSO
  session. The exception covers that module only. The repository rules record the exception.
- The two CI policies move together. The state bucket and trail denies moved from `mfc-demo-deploy-core` to
  `mfc-demo-deploy-data`, and `aws_iam_policy.deploy_core` depends on `aws_iam_policy.deploy_data`: the apply writes
  deploy-data first, so the denies exist before deploy-core stops carrying them. A rollback restores both policies,
  deploy-core first then deploy-data. Rolling back one of them alone re-opens denies (RUNBOOK_BOOTSTRAP_APPLY, rollback).
- A CI apply of a change whose plan updates `module.audit_trail` other than tags fails closed with AccessDenied, and
  it may be half-applied: the resources applied before the refused call stay changed. A CI guard that refuses such a
  plan before the apply is planned as a follow-up PR (CHECKLIST, CI/CD).
- The account-level setting covers every bucket of the account, including buckets created later. Its destroy calls
  `DeletePublicAccessBlock`, which turns the setting off for all buckets, so `prevent_destroy` stays. A rollback does
  not turn it off: nothing in the project depends on public access.
- No IAM action or setting is charged. The policy versions, the account setting and the validation calls are free,
  so this decision adds nothing to the cost (NFR-COST-1).
- No IAM analyzer is declared in code. The CHECKLIST keeps that item open.
- The mocked tests check the rendered documents. The live checks (Access Analyzer `validate-policy`,
  `simulate-custom-policy`, `simulate-principal-policy`, and `aws s3control get-public-access-block`) run before and
  after the bootstrap apply. Until they run, this ADR records the decision, not the state observed in AWS.
