# ADR 0002 — CI security gate before any feature

- Status: accepted
- Date: 2026-10-31
- Requirements: SEC-SEC-1, SEC-SUP-1, SEC-IAM-1

## Context

The project handles robot identities, operator tokens and a deploy role with AWS access, and the
repository is private on the GitHub Free plan (ADR 0003). The gate must exist before the first
feature, so that every later change meets it. Results have to be blocking checks on the pull
request, because code scanning alerts are not available to private repositories without a paid
add-on. CI minutes are limited (2,000 per month on Free). Every third-party action and every
downloaded binary is a supply-chain input, and every workflow trigger is an attack surface.

## Decision

Blocking checks, all run on pull requests; Gitleaks, Semgrep, Trivy, the audits and zizmor also run
on `main` and weekly (`security.yml`). Checkov and tflint run in the `terraform` job of `ci.yml`.

| Tool                                | Scope                                                                                                                 | Blocks on                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Gitleaks 8.30.1 (binary)            | Full git history, `--redact`                                                                                          | Any finding (`--exit-code 1`)                                           |
| Semgrep CE 1.181.0                  | Registry packs `p/default`, `p/typescript`, `p/react`, `p/python`, `p/terraform`, `p/github-actions` plus `.semgrep/` | Any finding at severity ERROR (`--error --severity ERROR`)              |
| Trivy 0.70.0 (through trivy-action) | Vulnerabilities, IaC misconfigurations and secrets, `.trivyignore` for reviewed exceptions                            | HIGH or CRITICAL with a fix available (`--ignore-unfixed`, exit code 1) |
| pnpm audit                          | Production dependencies, then all dependencies                                                                        | High (production) and Critical (all)                                    |
| pip-audit 2.10.1                    | Locked runtime Python set, hashes required (`uv export --no-dev --no-emit-project`)                                   | Any known vulnerability (`--strict`)                                    |
| zizmor 1.31.1                       | `.github/workflows`                                                                                                   | Any finding at medium severity or above                                 |
| Checkov (checkov-action)            | `infra/`, Terraform framework                                                                                         | Any failed check (`soft_fail: false`)                                   |
| tflint                              | `infra/`, with `.tflint.hcl` (Terraform and AWS rules)                                                                | Any error                                                               |

### Supply-chain policy

- pnpm: `minimumReleaseAge: 20160` (14 days in minutes), `strictDepBuilds: true`,
  `onlyBuiltDependencies: [esbuild]`, `engineStrict: true`.
- uv: `exclude-newer = "14 days"` and `required-version = ">=0.13,<0.14"` in `agent/pyproject.toml`.
- Dependabot: `cooldown: default-days: 14` on every ecosystem (npm, uv, github-actions, terraform,
  pre-commit, devcontainers).
- GitHub Actions: every `uses:` is pinned to a full commit SHA, with the release in a comment.
- Binaries downloaded by a workflow or the devcontainer are checked against a SHA-256 digest that is
  committed in the same file (Gitleaks in `security.yml`, Gitleaks and Trivy in
  `.devcontainer/post-create.sh`). trivy-action fetches its own binary, which is not checked by us.
- Tools run with `uvx` are pinned to exact versions. The 14-day rule applies to the uv project
  lockfile, not to `uvx` tool installs.

### Decisions inside the gate

- **Gitleaks as a pinned binary, not `gitleaks-action`.** The action needs a token with
  `pull-requests: read` on pull requests, which the least-privilege `contents: read` token does not
  grant. By default it scans only the pull request commits, and it hides the scanner version behind
  the wrapper. The binary is run with `fetch-depth: 0` over the full history, so the version and its
  bytes are reviewed in the workflow file.
- **Semgrep CE instead of CodeQL.** Code scanning on a private repository needs GitHub Code
  Security, which is paid. Semgrep CE runs as a blocking step and uploads SARIF as an artifact.
- **`deploy.yml` runs on `push` to `main` and calls `ci.yml` as a reusable workflow on the same
  commit.** The deploy job has `needs: ci`. A `workflow_run` trigger was rejected: zizmor reports it as
  a dangerous trigger, because a run started from a fork branch named `main` could mint an OIDC token
  with the subject that the deploy role trusts (`repo:vinsl@84448605/robot-fleet-console@1439837333:ref:refs/heads/main`).
- **Trivy action pinned by commit SHA.** Tags of the trivy-action repository were hijacked in March 2026
  (GHSA-69fq-xp46-6x23). The SHA pin is the release v0.36.0 and does not move with the tag.
- **`terraform-plan.yml` is skipped until `AWS_PLAN_ROLE_ARN` is set.** The job condition is
  `vars.AWS_PLAN_ROLE_ARN != ''`, so no OIDC token is requested before the read-only role exists.
  Until then, no plan is posted and the PR is not checked against the plan.
- **Permissions:** `contents: read` at the top of every workflow. Jobs escalate only where needed
  (`id-token: write` for the OIDC exchange, `pull-requests: write` for the plan comment).

## Alternatives considered

| Option                            | Pros                                         | Cons                                                                                            | Why not                                                                            |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gitleaks/gitleaks-action`        | One step, maintained by the vendor           | Needs `pull-requests: read`; scans PR commits by default; the wrapper hides the scanner version | Requires a wider token and does not show the exact binary that runs                |
| CodeQL with code scanning         | Native alerts in the Security tab            | Paid on private repositories (GitHub Code Security)                                             | No budget for it (NFR-COST-1)                                                      |
| `workflow_run` to deploy after CI | Deploy only after CI, separate workflow file | Flagged by zizmor as a dangerous trigger; runs with the default branch context                  | Fork-branch trigger risk on an OIDC role (see above)                               |
| Trivy action pinned by tag        | Updates without a PR                         | Tags were hijacked in March 2026                                                                | Immutable SHA pin instead                                                          |
| Terraform plan always on          | Plan visible on every PR from the start      | Needs the read-only role before M2                                                              | The plan role does not exist before M2; the job is in place and skipped until then |
| Scanners in pre-commit only       | Fast feedback                                | Hooks can be skipped with `--no-verify`                                                         | CI is the enforcement point; hooks are an early warning                            |

## Consequences

- Every push to a PR runs about 14 minutes of checks across the jobs. With 2,000 free minutes a
  month, this is the main budget constraint (ADR 0003).
- Dependabot does not update versions written inline in `run:` steps (Gitleaks, Trivy binary,
  Semgrep, zizmor, pip-audit, Checkov). They are bumped by hand, together with `Makefile` and
  `.devcontainer/post-create.sh`, which must carry the same versions.
- Gitleaks SHA-256 digests are updated by hand with each version.
- A skipped `terraform-plan` job does not fail the PR. Until the plan role exists, the plan is not a
  check.
- A blocking Semgrep or Trivy rule can stop a change for a false positive. The exception goes into
  `.trivyignore` or a Semgrep `nosemgrep` comment with a reason, and the reason is reviewed.
- Security cost: none in AWS. The gate runs on GitHub-hosted runners only.
