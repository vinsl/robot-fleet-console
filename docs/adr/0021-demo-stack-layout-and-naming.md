# ADR 0021 — Demo stack layout: one root, modules, default tags and the mfc-demo- prefix

- Status: accepted
- Date: 2026-10-31
- Requirements: NFR-MAINT-1, NFR-COST-1, SEC-IAM-1, SEC-SEC-1

## Context

The demo account holds one application stack. CI grants access by name: the deploy and plan policies match
the `mfc-demo-` prefix and the state key `envs/demo/` (ADR 0020, ADR 0005). Three budgets already exist in
the account and must be adopted without being recreated. CI runs plans without `-var` flags, and the code
is reviewed by people who did not write it, so the layout must be easy to read.

## Decision

- One root, `infra/envs/demo/`, with the state key `envs/demo/terraform.tfstate` (ADR 0005). It holds the
  budgets, their import blocks, the outputs read by `make smoke`, and the calls of two modules in
  `infra/modules/`: `audit-trail` (ADR 0022) and `alarm-topic` (ADR 0023). Modules declare no provider.
- The root sets the four cost-allocation tags in the `default_tags` of its only AWS provider: `project = mfc`,
  `env = demo`, `component = foundation` and `owner`. Resources do not set tags themselves, so none can forget
  them. TFLint enforces the four keys with `aws_provider_missing_default_tags` (`.tflint.hcl`).
- The name prefix `mfc-demo` is a constant local, not a variable. The CI policies and the workload boundary
  match that exact prefix (ADR 0020). A variable could drift from them.
- The region variable accepts `eu-west-3` and `eu-west-1` only (ADR 0006). The bucket suffix is a validated
  variable, because S3 bucket names are global.
- Every variable has a default. The alarm address is not a variable: it is read from SSM (ADR 0023).
- The tests of the root and of its modules run from `infra/envs/demo/tests/`, with mocked providers and
  `module` blocks. The modules have no test folder of their own.

## Alternatives considered

| Option                        | Pros                           | Cons                                                                                           | Why not                                                                                    |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Terraform workspaces          | One code path and one backend  | Changes the state key that the CI policies match; a workspace name is easy to mix up in a plan | The policies match `envs/demo/*`; a separate root keeps the budgets apart from other state |
| Tags written on each resource | Explicit at the resource       | Easy to forget; TFLint cannot see a missing tag without the provider rule                      | `default_tags` removes the failure mode                                                    |
| Name prefix as a variable     | Reuse for a second environment | The CI policies hard-code `mfc-demo-*`, so a second environment would fall outside them        | One environment in this account, by design                                                 |
| Budgets inside a module       | Reuse                          | Budgets are account-level and adopted by import, not created by the stack                      | Kept in the root, where the import is visible                                              |

## Consequences

- A new resource needs no tag code. A resource that the provider cannot tag is not tagged, and the TFLint rule
  checks only the provider block, not each resource.
- `component` is `foundation` for every resource of this root, so cost grouped by `component` shows one value
  until a second root exists.
- A second environment needs a second root, a new prefix and new CI policies (ADR 0020). It is not a variable change.
