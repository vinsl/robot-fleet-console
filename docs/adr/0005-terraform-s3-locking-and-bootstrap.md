# ADR 0005 — Terraform with S3 native locking and a separate bootstrap

- Status: accepted
- Date: 2026-10-31
- Requirements: NFR-MAINT-1, NFR-COST-1, SEC-SEC-1, SEC-IAM-1

## Context

One AWS account and one developer write all the Terraform. The state holds resource attributes, so it
must live in a private, encrypted bucket with locking, and no paid service may hold it. The state bucket
and the CI roles must exist before the workflows can run, and CI must not be able to change the roles it
assumes. A bootstrap root is therefore needed: a stack that holds the state bucket, the GitHub OIDC trust,
the CI roles and the permission boundary, and that only a human applies.

## Decision

- Two roots under `infra/`. `infra/bootstrap/` holds the state bucket, the GitHub OIDC provider, the two
  CI roles, the workload permission boundary and the alarm e-mail parameter. `infra/envs/demo/` holds the
  application stack.
- Bootstrap is applied by the owner from an SSO session. The first apply uses local state
  through a git-ignored `override.tf` that swaps the backend for `backend "local" {}` (`init -backend=false`
  is not enough: `plan` still demands the S3 backend); then `terraform init -migrate-state` moves it into the bucket under
  `bootstrap/terraform.tfstate`. Later bootstrap changes go through a PR and are applied by the owner.
- The demo state is `envs/demo/terraform.tfstate` in the same bucket. Only `deploy.yml` applies it, on
  `push` to `main` (ADR 0002). Pull request plans are read-only (`terraform-plan.yml`).
- State bucket `mfc-demo-tfstate-vinsl`: versioning enabled, SSE-S3 (AES256), all four public access
  blocks, `BucketOwnerEnforced`, a bucket policy that denies requests without TLS and TLS below 1.2,
  noncurrent versions expire after 90 days, and `prevent_destroy` set.
- Locking uses `use_lockfile = true` (S3 native locking, Terraform 1.10 or later; `required_version` is
  `>= 1.17, < 2.0`). No DynamoDB table.
- Pull request plans run with `-lock=false`. The plan role is read-only and cannot create the lock object.
  A plan only reads state, so a plan that runs during an apply cannot corrupt it. The deploy plan and
  apply keep the lock.
- Every name carries the `mfc-demo-` prefix, which the deploy policies match (ADR 0020).
- The alarm address is the `sensitive` variable `alarm_email`, written to the SSM String parameter
  `/mfc-demo/alarm-email`. It is not stored in any repository file. Terraform keeps the value in state, so
  the state bucket is treated as sensitive.
- AWS Budgets are denominated in USD, with conservative thresholds: 1 USD is worth less than 1 EUR, so a
  USD threshold is reached at a lower euro amount and the alert fires first.
- Three budgets were created by hand on 2026-10-30 (`docs/COSTS.md`): `3-Euros Alarm` (limit 3.25 USD),
  `5-Euros Alarm` (limit 5.40 USD) and `Zero-Spend Alarm` (limit 1.00 USD). The demo stack imports all three
  under these exact names and with these limits. The names are listed in `infra/bootstrap/terraform.tfvars`
  (`budget_names`), and the deploy role may modify exactly these budgets. Notification thresholds are defined
  in code, and the plan comment of the pull request shows their diff. The budget name forces replacement
  when changed, so a rename would delete and recreate the budget. The notification blocks are masked in plans
  because they carry the alarm address (see ADR 0023).

## Alternatives considered

| Option                          | Pros                                           | Cons                                                                                                   | Why not                                                                   |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Terraform Cloud (HCP Terraform) | Locking, state and run history outside AWS     | Second service and account; state and the CI role definitions sit outside the AWS trust boundary       | One developer does not need a second trust relation for state             |
| DynamoDB lock table             | Long-standing locking method of the S3 backend | One more table to create, protect and review; `use_lockfile` removes the need                          | Terraform 1.10 provides locking in S3 itself                              |
| State bucket created by hand    | No code to write                               | Not reviewed, not reproducible from the repository, not tested                                         | The bucket is the most sensitive store of the project and must be in code |
| One root for everything         | One apply, one state                           | CI would change the roles it assumes, and the bucket would hold the state of the stack that creates it | Circular trust: the deploy role could widen itself                        |

## Consequences

- Any new AWS service needs a bootstrap PR, because the deploy permissions live in
  `infra/bootstrap/policies.tf`. The owner applies that PR before the deploy workflow can use the service.
- A pull request plan can show a state that an apply changes a moment later. The plan is a review aid; the
  deploy workflow plans again under the lock.
- The backend block cannot take variables, so the bucket name and region are literals in
  `infra/bootstrap/versions.tf` and must match `variables.tf`.
- The state bucket holds the alarm address and resource attributes. Access is by IAM only; the deploy role
  may write any key except `bootstrap/*` (ADR 0020).
- Cost: state storage is negligible and there is no lock table to pay for.
- Recovery: a bad apply is reverted by restoring the previous object version, which versioning keeps.
