# ADR 0003 — GitHub Free plan with procedural protection of main

- Status: accepted
- Date: 2026-10-31
- Requirements: SEC-IAM-1, SEC-SUP-1, NFR-COST-1

## Context

The repository is private. On a private repository, branch protection and rulesets need GitHub Pro,
Team or Enterprise: the API returns 403 on Free. Required reviewers on environments are not available
on Free, Pro or Team. Code scanning needs a paid add-on. The project target is 0 € out of pocket
(NFR-COST-1), and a paid plan for one month would break it. Without any protection, a direct push to
`main` would reach the deploy workflow, which runs on every push to `main`.

The owner decided on 2026-10-31 to keep the Free plan and to use the fallback described in
`docs/security/CI_CD.md`.

## Decision

Protect `main` with local and procedural controls, and state in the report that GitHub does not
enforce them:

1. The `no-commit-to-branch` pre-commit hook (`--branch main`) and the `guard-bash.sh` Claude Code hook
   refuse commits and pushes to `main` on the developer machine.
2. The Claude Code permissions in `.claude/settings.json` deny `git push origin main`,
   `git push origin HEAD:main`, and force pushes.
3. Pull requests are merged only with `gh pr merge --squash --delete-branch`, and only after
   `gh pr checks` reports every check green.
4. `deploy.yml` runs on `push` to `main` and calls `ci.yml` and `security.yml` on the same commit. The deploy job
   needs both, so a commit that fails the quality or security gate on `main` does not deploy.

`infra/github/ruleset-main.json` is kept in the repository. It is the ruleset to apply if the
repository moves to a paid plan:

```bash
gh api -X POST repos/vinsl/robot-fleet-console/rulesets --input infra/github/ruleset-main.json
```

## Alternatives considered

| Option                                      | Pros                                                                            | Cons                                                                                          | Why not                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GitHub Pro for the month                    | Server-side rules: no direct push, required checks, linear history, squash only | Paid; the project target is 0 €                                                               | Breaks NFR-COST-1 for a control that the local controls approximate |
| Free plan with procedural controls (chosen) | No cost; the controls live in the repository and are reviewable                 | Not enforced by GitHub; bypassable by `--no-verify` or by a manual merge in the web interface | Accepted, with the limits stated below                              |
| No protection on `main`                     | Simplest                                                                        | A push to `main` deploys directly                                                             | Unacceptable for a deploy workflow that targets AWS                 |

## Consequences

- **Protection is procedural.** GitHub does not refuse a push to `main` or a merge with red checks.
  The controls depend on the hook being installed (`make hooks`), on Claude Code honouring its
  settings, and on the merge procedure being followed. The report states this limit.
- **No required status checks.** A pull request can be merged by hand while a check is red. The CI
  run on `main` after the merge still blocks the deploy.
- **No environment approval.** The deploy job has no required reviewer. The `allow_destroy` input of
  `deploy.yml` can be set by anyone with write access to the repository. On this single-owner
  repository, that is the owner only.
- **Actions minutes.** Private repositories on Free get 2,000 Actions minutes per month. At about
  14 minutes per push, the budget covers roughly 140 pushes a month. A failed or repeated run uses the
  same budget, so the `concurrency` settings in the workflows matter.
- **Upgrade path.** If the repository moves to a paid plan, apply `infra/github/ruleset-main.json`
  (command above) and move the procedural checks in `CI_CD.md` to "server-side" in the report.
- **Security impact.** The deploy role still trusts only `refs/heads/main` (ADR 0002), so a feature
  branch cannot deploy even without the ruleset. No AWS cost.
