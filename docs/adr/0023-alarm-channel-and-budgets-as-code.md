# ADR 0023 — Alarm e-mail channel and budgets as code

- Status: accepted
- Date: 2026-10-31
- Requirements: NFR-OBS-2, NFR-COST-1, SEC-SEC-1, SEC-LOG-1

## Context

Three AWS Budgets were created by hand on 2026-10-30 (ADR 0005): `3-Euros Alarm` (limit 3.25 USD),
`5-Euros Alarm` (limit 5.4 USD) and `Zero-Spend Alarm` (limit 1.0 USD). Each one e-mails the alarm address.
They must become code without being recreated, because a rename or a delete loses their history and their
names. The alarm address must not appear in any repository file, yet every budget notification and the SNS
subscription need it. Budgets e-mail directly. The SNS topic is the channel for CloudWatch alarms, and those
arrive in M10. The Zero-Spend budget counted gross usage, so credits did not offset the spend (see the
JOURNAL entry of 2026-10-31).

## Decision

1. **Address.** The bootstrap root writes the address to the SSM String parameter `/mfc-demo/alarm-email`
   (ADR 0005). The demo root reads it with `data "aws_ssm_parameter"`, whose value is sensitive, and passes it
   to the module variable `alarm_email`, also sensitive and validated. Plans show "(sensitive value)" for the
   budget notifications and the subscription. No file or variable of the repository holds the address.
2. **Budgets.** The three budgets are adopted with `import` blocks under their exact names
   (`<account>:<name>`). Each budget sets `billing_view_arn`, `metrics = ["UnblendedCost"]` and a `RECORD_TYPE`
   filter explicitly, because the console sets them and an omitted attribute plans a change. The budget resource
   has `prevent_destroy = true`: a rename, which forces replacement, fails at plan time.
3. **Thresholds.** The 3 € and 5 € budgets exclude credits and refunds, so they track gross usage. The
   Zero-Spend budget excludes only refunds, so it tracks the net charge: credits offset the spend, and the alert
   fires only on money actually owed (NFR-COST-1). The owner approved this change on 2026-10-31.
4. **Teardown.** `make destroy` removes the three budgets from the state (`terraform state rm`) before
   `terraform destroy`, so the teardown leaves them alone. The import blocks stay in code, so the next deploy adopts
   them again. If the state does not exist, `state list` fails, the removal is skipped, and nothing is tracked.
   If the budgets are still tracked, `prevent_destroy` makes the teardown fail.
   On 2026-10-31, with Terraform 1.17.1, a read-only `plan -destroy` against an empty local state of a copy of
   `envs/demo` (import blocks present, real provider) planned "No changes", so destroy ignores the import blocks.
   The Makefile recipe itself has no automated test.
5. **Topic.** `mfc-demo-alarms` signs messages with SHA-256. Its policy admits only `cloudwatch.amazonaws.com`, from
   this account, for alarms named `mfc-demo-*`, and refuses publishes without TLS. It has one e-mail subscription to
   the alarm address. It has no server-side encryption (THREAT_MODEL R16). The stack's CloudWatch alarms publish to it: the Errors and Throttles alarms of each Lambda function (lambda-function
   module), the ParseError alarms of the IoT rules (iot-rules module), the queue alarms and the API 5xx alarm (M10).
6. **Scope of CI.** The deploy role may modify exactly the three budget names listed in `budget_names`
   (`infra/bootstrap/terraform.tfvars`), so CI cannot change another budget.

## Alternatives considered

| Option                                 | Pros                        | Cons                                                                                                  | Why not                                                                        |
| -------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Budgets left as console objects        | No code to write            | No review, no test, no drift check; a console edit is never noticed                                   | The budgets are part of the cost policy and must be reviewed like any resource |
| Budgets recreated from code            | Simple                      | Loses the names and history; a delete could run before the create                                     | Import keeps the existing objects                                              |
| Address in a git-ignored tfvars file   | Simple                      | Not reproducible; CI cannot plan without it                                                           | SSM is reachable by the CI roles within their boundary                         |
| SecureString for the address           | Encryption at rest          | The address is not a credential, and a key policy adds a surface for nothing                          | Kept as String (`infra/bootstrap/ssm.tf`)                                      |
| Budget notifications through the topic | One channel                 | The topic policy would need `budgets.amazonaws.com`, which widens it                                  | Budgets e-mail directly; the topic stays limited to CloudWatch alarms          |
| Topic with a customer-managed key      | Encryption with key control | CloudWatch alarms cannot publish to an AWS-managed key topic, and a customer key is excluded for cost | THREAT_MODEL R16                                                               |
| Zero-Spend on gross usage (kept)       | Strictest signal            | Fires on usage the account does not pay, because credits do not offset it                             | Replaced by the net-charge filter, approved on 2026-10-31                      |

## Consequences

- The state holds the address in clear text (THREAT_MODEL R17). The state bucket is private and IAM-only.
- The first plan was checked with a read-only plan on 2026-10-31 and is not yet run in CI: 3 imports, 11 additions,
  3 updates (tags_all on the three budgets, plus the filter on Zero-Spend), 0 deletions. The Zero-Spend filter stops
  counting credits from that deploy on.
- The first deploy needs the owner to confirm the subscription from the e-mail within 3 days. AWS deletes an
  unconfirmed subscription after that, and a later plan creates it again.
- A budget that is removed from code, or renamed, fails at plan time. `make destroy` is the only path that
  detaches the budgets from state.
- AWS Budgets may bill budgets beyond its free allowance. The cost of the three budgets is not yet checked
  against the bill (see `docs/COSTS.md`).
- The Lambda alarms also notify on the return to OK (`ok_actions`), so a recovery sends an e-mail as well as the alarm.
