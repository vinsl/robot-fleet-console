# ADR 0020 — GitHub OIDC roles and deploy permission boundary

- Status: accepted
- Amended by: ADR 0024
- Date: 2026-10-31
- Requirements: SEC-IAM-1, SEC-SUP-1, SEC-LOG-1, NFR-COST-1

## Context

GitHub Actions must plan and deploy into the AWS account without stored keys (ADR 0002). The deploy role
must create the Lambda execution roles of the demo, so it can grant rights, which makes it the most
powerful identity in the project. Administrator access would make a stolen token a full account takeover.
The account is dedicated to this demo, but the rule of least privilege still applies to the CI path.

## Decision

Two CI roles, in the IAM path `/mfc-demo-ci/`, each trusted for exactly one GitHub subject with
`StringEquals` (ADR 0002 and `infra/bootstrap/roles.tf`):

- `mfc-demo-gha-plan`, trusted for `repo:vinsl@84448605/robot-fleet-console@1439837333:pull_request`. Permissions:
  `ReadOnlyAccess` and `mfc-demo-plan-guard`. The guard denies object reads outside the demo and bootstrap
  state, DynamoDB item reads and PartiQL queries, Kinesis Video media, log contents and log query results,
  Cognito user listings, SQS messages, secret values, SSM parameters other than the alarm address, IoT
  retained messages and device shadows, X-Ray traces, and CloudTrail event lookups.
- `mfc-demo-gha-deploy`, trusted for `repo:vinsl@84448605/robot-fleet-console@1439837333:ref:refs/heads/main`. Permissions:
  `ReadOnlyAccess` and five customer-managed write policies (`mfc-demo-deploy-core`, `-data`, `-compute`,
  `-edge`, `-iot`), split so that each stays under the 6144-character IAM limit (checked in
  `infra/bootstrap/tests/iam.tftest.hcl`).

The write policies grant actions on names with the `mfc-demo-*` prefix or in `/mfc-demo/` paths. Roles that
the deploy creates must carry the permission boundary `mfc-demo-workload-boundary`:

- `iam:CreateRole` and `iam:PutRolePermissionsBoundary` are allowed only when `iam:PermissionsBoundary` is
  that boundary.
- `iam:PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy` and `DetachRolePolicy` have no boundary
  condition, because the request does not carry the `iam:PermissionsBoundary` key, so such a condition
  would never match. They are scoped to the `/mfc-demo/` path, and the boundary caps what they grant.
- The boundary denies IAM, `sts:AssumeRole` and Organizations, the state bucket and the trail bucket. The deploy
  role cannot delete a role's boundary.
- The boundary allows `*` only for `xray:*` and `cloudwatch:PutMetricData`, which have no resource-level ARN, and
  for `iot:CreateKeysAndCertificate`, which has no resource type (see the amendment below).
  Every other allow is scoped: IoT clients, things and role aliases on `mfc-demo-*`, topics and topic filters on
  `fleet/*` (see Naming), IoT certificates on `cert/*` (amendment below), Kinesis Video channels and streams on
  `mfc-demo-*`, six log-group ARNs (`/aws/lambda/mfc-demo-*`, `/aws/apigateway/mfc-demo-*`, `/mfc-demo/*`) and the two
  `AWSIotLogsV2` ARNs (amendment below), Cognito user pools only when tagged `project = mfc`, `lambda:InvokeFunction` on
  `mfc-demo-*`, and `execute-api:ManageConnections` on the account and region, because API ids are generated and cannot
  be prefixed.

Explicit denies protect the CI roles (`/mfc-demo-ci/`), the GitHub OIDC provider, the state bucket
administration (policy, versioning, lifecycle, public access block, ownership, encryption), the bootstrap
state objects, and the audit evidence:

- `cloudtrail:CreateTrail`, `cloudtrail:StopLogging`, `cloudtrail:DeleteTrail`, `cloudtrail:UpdateTrail` and
  `cloudtrail:PutEventSelectors` on every trail, and `access-analyzer:DeleteAnalyzer`.
- Every action on the trail bucket (`mfc-demo-trail-*`) except reads and tags for the deploy role, and every S3
  action on it in the workload boundary (ADR 0024); `s3:DeleteObjectVersion` on the state bucket (THREAT_MODEL R10,
  R15).

Each deny sits in its own statement, so that no Allow added later can undo it. `iam.tftest.hcl` checks each
of them.

### Naming

- Robot thing names are `mfc-demo-<robotId>`, and each robot's KVS channel carries the same name. The
  boundary and the deploy policies match these names on the prefix. A thing or channel without the prefix
  falls outside them and is refused.
- MQTT topics keep the SPEC section 5 namespace `fleet/{site}/{robot}/...`. This is an accepted exception to
  prefix scoping: topic ARNs are scoped to `fleet/*` instead, because an `mfc-demo-*` ARN would deny the
  commands that the cloud publishes.

### Immutable OIDC subjects

The repository has immutable OIDC subjects enabled, so GitHub writes the owner and repository ids into the
token subject: `owner@ownerId/repo@repoId`. The trust conditions use that form, read from
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`infra/bootstrap/variables.tf`). A trust on the
mutable name would not match any token and would fail every run. It would also trust whatever repository
later takes that name. The ids are public GitHub identifiers, not secrets.

Disabling immutable subjects in the repository settings was rejected. It would make the trust match the name
again, and a deleted repository whose name is reused by another account could then assume the CI roles.

### Trail configuration

- CI can start logging and tag the trail (`cloudtrail:StartLogging`, `AddTags`, `RemoveTags`), but it cannot
  create it (`CreateTrail` is denied since ADR 0024), update it or change its event selectors. A trail
  configuration change is therefore applied by the owner from their own SSO session (ADR 0022, ADR 0024).
- `envs/demo` must not declare event selectors. The AWS provider calls `PutEventSelectors` when a trail
  declares them, and the deploy role is denied that action.

## Alternatives considered

| Option                             | Pros                                                            | Cons                                                                               | Why not                                               |
| ---------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| GitHub environment as OIDC subject | Subject tied to an environment, which can hold protection rules | Environment protection rules need a paid plan (ADR 0003); no gain on the Free plan | The branch subject already limits the trust to `main` |
| `AdministratorAccess` for deploy   | Nothing to maintain                                             | A stolen token on `main` controls the account, IAM included                        | Rejected: the blast radius is the whole account       |
| Immutable subjects disabled        | Trust reads the readable `owner/repo` name                      | A reused repository name, after a deletion, would match the trust                  | Rejected: the immutable id stops name reuse           |

## Consequences

- **Scope is account and region, not name, for some services.** CloudFront, API Gateway and Cognito create
  resources with random identifiers, so their ARNs cannot be named in advance. Cognito user pools are
  limited by the tag `project = mfc`; CloudFront and API Gateway are limited by account and region.
- **A stolen deploy token on `main` can change any of those resources** in this dedicated account. The
  control is the `main` trust and the single writer of the repository (ADR 0003).
- **The deploy role can write state objects.** `mfc-demo-deploy-data` grants `s3:*` on `mfc-demo-*`, which
  includes the state bucket. Bucket administration and `bootstrap/*` are denied, and so is
  `s3:DeleteObjectVersion` on the state bucket, so a previous state version stays in place after a bad write.
  Accepted: the deploy must write its state (THREAT_MODEL R10).
- **Roles on `/mfc-demo/` created without the boundary are not capped.** The boundary is applied only at
  creation. All roles of the path must be created by Terraform; a role made by hand on that path would
  accept any policy the deploy role attaches.
- **Trust policies of workload roles are not constrained by IAM** (THREAT_MODEL R11). A change merged to `main`
  could create a role that an external principal assumes, within the boundary. A Terraform test limiting the
  trust to the five service principals was planned for the demo-stack PR and was not written. The accepted risk
  is THREAT_MODEL R11.
- **Trail changes come from the owner's SSO session** (see Trail configuration; ADR 0024). The deploy role cannot
  reconfigure a trail it created.
- **The trail bucket is read-only to CI except its tags**, and its changes are applied from the owner's SSO session
  (ADR 0024).
- **A new AWS service needs a bootstrap PR,** applied by the owner, before the deploy workflow can use it.
- **The plan role runs code from pull requests.** Its residual risk is in THREAT_MODEL R9.
- **The e2e role is deferred.** The e2e job assumes `mfc-demo-gha-e2e` through `vars.AWS_E2E_ROLE_ARN`, a
  role created in M10 (THREAT_MODEL R7). The deploy role is not used by e2e.
- A rename or transfer of the repository or of the owner account changes the subject and both roles stop matching (fails closed); update `github_oidc_repository` in a bootstrap PR applied by the owner.
- Cost: no AWS charge for IAM roles, policies or the OIDC provider.

## Amendment (2026-11-01): robot identity grants

The robot identity of M4 (per-robot certificates, the IoT rules and the IoT logging) needs actions that the
bootstrap did not grant. One bootstrap change corrects them. Three managed policies get a new default version
(`mfc-demo-workload-boundary`, `mfc-demo-deploy-core`, `mfc-demo-deploy-iot`); no policy is renamed or replaced.

- **Topic rules use the `rule` resource type.** `mfc-demo-deploy-iot` granted `topicrule/mfc_demo_*`, which is not an
  IAM resource type, so CI could not create any topic rule. It now grants `rule/mfc_demo_*`.
- **The IoT V2 logging group has a fixed name.** AWS IoT writes to `AWSIotLogsV2`, which carries no demo prefix, so it
  was outside the boundary. `mfc-demo-deploy-core` and the workload boundary now name that group and its streams.
- **Certificate creation is granted on `*`.** `iot:CreateKeysAndCertificate` has no resource type, and AWS generates
  the certificate id. The workload boundary grants it on `*`, and nothing else.
- **Certificate lifecycle is granted on `cert/*`.** The workload boundary grants `iot:UpdateCertificate`,
  `iot:AttachPolicy` and `iot:DetachPolicy` on `arn:aws:iot:<region>:<account>:cert/*`. `iot:AttachThingPrincipal` and
  `iot:DetachThingPrincipal` sit in their own statement, `WorkloadIotThingPrincipals`, on the same ARN, with the
  condition `ArnLike` on `iot:thingArn` matching `thing/mfc-demo-*`. The thing key exists for those two actions only, so
  a certificate can be bound only to a demo thing. The certificate id is generated by AWS, so the certificate ARN cannot
  carry the demo prefix. `iot:AttachPolicy` has no condition key and accepts any policy of the account, so the policy
  cannot be limited by name; the policy is checked by the IoT policy inventory (THREAT_MODEL R20).
  `iot:DeleteCertificate` is never granted: a retired certificate is revoked and kept.

The residual risk is THREAT_MODEL R20. The tests `iot_topic_rules_use_the_rule_resource_type`,
`boundary_scopes_iot_certificates` and `iot_log_group_is_the_only_unprefixed_log_group` (in
`infra/bootstrap/tests/iam.tftest.hcl`) and the allow-list of `workload_boundary_has_no_global_resource_allow` pin
these grants. The owner applies the change from the runbook; the live check with `aws iam simulate-custom-policy` on the
rendered boundary is recorded in the security checklist after the apply.
