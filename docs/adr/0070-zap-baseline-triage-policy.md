# ADR 0070 — ZAP baseline triage policy: report first, then fail the job

- Status: accepted (rollout in two PRs: step 1 sets `fail_action: false`, step 2 sets it to `true` after triage)
- Date: 2026-11-04
- Requirements: SEC-WEB-1, NFR-TEST
- Implemented in: `.github/workflows/deploy.yml` (job `dast`), `.zap/rules.tsv`, `docs/security/THREAT_MODEL.md`

## Context

The `dast` job runs `zaproxy/action-baseline` (pinned by SHA) against the console URL after each deploy on `main`. The
scan is passive: it reads the unauthenticated console and does not send credentials or touch the API. The action passes
the ZAP exit code through when `fail_action` is true, and ZAP exits non-zero on any alert that is not ignored by a rule
of the rules file. A `WARN` row therefore does not triage an alert: with `fail_action: true` it keeps the job red.
The current `.zap/rules.tsv` has one such row (`10096 WARN`, timestamp disclosure in hashed asset names), so the file as
it stands cannot pass.

The console has never been scanned. The first run can report findings that nobody has read yet, and a red job on
`main` blocks the signal that every later commit depends on. The workflow can only run on `main` (it needs the
deployed URL), so a failed first run would not be seen on a pull request.

## Decision

The baseline runs in two steps, each in its own PR.

1. **PR A, `fail_action: false`.** The scan runs with `cmd_options: "-j -m 3"` (AJAX spider, three minutes, so the SPA
   routes are discovered), the image is pinned by digest when the digest can be verified at implementation time, and
   `10096` moves from `WARN` to `IGNORE` with its reason. The report is kept as the `zap-baseline` artifact. The job
   reports and does not fail.
2. **Triage after the first `main` run.** The main session downloads the artifact and classifies each alert id:
   - **fix** in `infra/modules/web` (response headers, for example a missing `Permissions-Policy`), by a separate PR;
   - **IGNORE** in `.zap/rules.tsv` with a reason and a link to the threat model, when the alert is not a risk here (for
     example `90005`, Sec-Fetch headers, informational);
   - **accepted risk** in `docs/security/THREAT_MODEL.md`, when the alert is real and is not fixed.
3. **PR B, `fail_action: true`.** Once every alert of the first run is fixed, ignored with a reason or accepted, the flag
   is set to `true`. From then on any new alert fails the `dast` job on `main`.

Rules file format: one row per rule, three tab-separated columns: the rule id, `IGNORE`, `WARN` or `FAIL`, and the reason
with its threat or risk id. A `WARN` row is not used: it does not triage anything under `fail_action: true`. Every
`IGNORE` needs a reason and a link to `THREAT_MODEL.md`.

Scope of the scan, stated here so that nobody reads more into a green job: the baseline covers only the unauthenticated
console (R99). The API and the WebSocket are authenticated, and they are covered by the denied-access tests (ADR 0047),
not by ZAP. Active scanning is not run: it sends attack payloads to a deployed stack, and the demo does not need it.

## Alternatives considered

| Option                                    | Pros                                  | Cons                                                                    | Why not                                                                  |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `fail_action: true` from the first run    | One step, the gate is on from day one | The first findings are unknown; a red `main` blocks every later commit  | Unpredictable first run on a never-scanned site; triage needs the report |
| No DAST job, rely on the header tests     | No cost, no triage                    | The baseline finds what the tests do not expect (crawl, unknown routes) | The PLAN asks for the baseline and its triage                            |
| Active scan (`zap-full-scan`)             | Finds more                            | Sends attack payloads to the deployed stack; slower; needs more triage  | Out of scope for a demo; passive coverage of the console is enough       |
| Keep a `WARN` row to record a known alert | Looks like a record of the decision   | Under `fail_action: true` it keeps the job red and triages nothing      | Replaced by `IGNORE` with a reason and a link                            |
| Issue writing on the repository           | Alerts visible in the issue list      | Needs write permission on the issues; creates public-looking noise      | The artifact is enough; `allow_issue_writing: false` stays               |

## Consequences

- The first `main` run after PR A produces a report and a green job even if the report has findings. The findings are
  triaged by hand before PR B, so the triage is the point of the step, not the job colour.
- The `10096` alert is not a secret, but it is a rule that needs a link to a threat or risk row. PR A adds that row
  when it moves `10096` to `IGNORE`, so the file never holds a row without a reason.
- After PR B, every new alert on `main` fails the `dast` job, and the job takes about 6 minutes of runner time per push.
  The image digest must be re-verified when the pin is updated.
- The baseline does not see the API or the WebSocket. The residual risk is stated as R99, and it is accepted for the
  demo.
- The `zap-baseline` artifact holds the scan of the public console. The scan sends no credential, so the artifact holds
  none.
