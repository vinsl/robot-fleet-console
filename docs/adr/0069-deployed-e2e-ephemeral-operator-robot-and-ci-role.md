# ADR 0069 — Deployed-URL e2e with an ephemeral Operator, an ephemeral simulated robot and a dedicated CI role

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-AUTH-1, FR-AUTH-2, FR-AUTH-3, FR-CTL, NFR-TEST, SEC-IAM-1, SEC-WEB-1, SEC-WEB-2
- Implemented in: `scripts/e2e-setup.sh`, `scripts/e2e-teardown.sh`, `scripts/e2e-process.sh`,
  `scripts/e2e-state-dir.sh`, `scripts/e2e-scan-report.mjs`, `apps/console/e2e/`, `apps/console/playwright.config.ts`,
  `infra/bootstrap/policies.tf` (role `mfc-demo-gha-e2e`), `infra/bootstrap/tests/iam.tftest.hcl`

## Context

The demo scenario (sign in with TOTP, see the robot, take the lock, pause, e-stop) only means something on the deployed
stack: the real user pool, the real HTTP API, the real IoT rules and the real robot protocol. The fake authentication
seam of ADR 0051 cannot prove it, because its token is not a JWT and the API rejects it. A stored test account would
hold a long-lived password and a TOTP seed in the repository or in the CI secrets, which the project rules forbid (no stored
credentials, no long-lived keys).

The deploy role holds `cognito-idp:*` and `iot:*` on the project resources. Reusing it for a test would give a test job
far more than it needs (threat R7). The test also runs on every push to `main`, so its role must be as narrow as the
job itself.

## Decision

Each run of the deployed e2e job creates its own Operator and its own simulated robot, drives the first sign-in through
the real UI, runs the scenario, and deletes both, even on failure.

- **Lifecycle.** `make e2e-setup` creates the user (`AdminCreateUser`, email verified, `SUPPRESS`, temporary password),
  adds it to the `Operator` group, registers a simulated robot through `scripts/robots-admin.sh` and starts the
  production simulator. `make e2e` runs Playwright. `make e2e-teardown` (always run) stops the simulator, retires the
  robot, deletes the user, and removes the robot kit and the state directory.
- **First sign-in.** The test performs the temporary-password change and the TOTP enrolment through the UI. It reads the
  enrolment key from the screen and computes the codes with an RFC 6238 helper built on `node:crypto`. Cognito generates
  the TOTP secret per run, and the secret dies with the user.
- **Dedicated role.** `mfc-demo-gha-e2e` is created in `infra/bootstrap`. Its trust accepts only the `main` branch
  subject, with `StringEquals`, and audience `sts.amazonaws.com`. It has no managed policy. Its policy has five statements:
  the four Cognito admin actions on `userpool/*` with the condition `aws:ResourceTag/project = mfc`,
  `lambda:InvokeFunction` on the exact function `mfc-demo-robots`, and the three consumer statements below. The role
  holds no `lambda:*` and no `iam:PassRole`. The role does not read Terraform state; the pool id comes from the public
  `config.json`.
- **Consumer.** The robots list shows only robots with live state, and live state needs the telemetry ingest consumer
  (the SQS event source mapping of `mfc-demo-ingest-telemetry`, ADR 0039). `scripts/e2e-setup.sh` reads the consumer
  state, records it as `consumerWasEnabled` in the state file before any change, and enables the consumer only when it
  was `Disabled`; an `Enabled` consumer is left as it is, because another demo may use it. A transitional state
  (`Enabling`, `Disabling`, `Updating`) stops the run instead of guessing. `scripts/e2e-teardown.sh` restores `Disabled`
  only when the state records `consumerWasEnabled: false`. The restore is blind: a consumer that someone else enables
  during the run is disabled at teardown, which is accepted because a run lasts minutes. After a hard failure such as a
  runner crash, teardown does not run and the consumer may stay enabled; `make demo-stop` disables it (R103). The role
  reads the mappings with `lambda:ListEventSourceMappings` on `*` (IAM has no resource for it) and
  `lambda:GetEventSourceMapping` on the mappings, without a condition, and it may update only the mapping bound to
  the ingest function: `lambda:UpdateEventSourceMapping` with `ArnEquals lambda:FunctionArn`. A missing key fails closed.
- **Simulator.** The production simulator runs with `--count=1`, `--fault-rate-per-hour=0` (no random fault can make the
  scenario flaky) and `--max-runtime-seconds=900` as the cost guard if teardown never runs. It has only its certificate;
  the AWS variables are not in its environment.
- **Retries.** The test has no retries. The operator of a run is used once, so a retry would meet an enrolled account and
  hide the first failure.
- **Secrets.** Passwords reach Cognito through `--cli-input-json file://`, never through argv. Every generated secret is
  masked with `::add-mask::` before its first use. The state directory is mode 700 and the state file mode 600. Steps
  that handle a secret run inside `test.step(..., { box: true })`.

Deviations and details fixed while implementing the design (the design is the source for the rest):

1. **Reporters.** The reporters are `list` and `junit` only. The `html` reporter stores its data in a compressed zip,
   which the secret scan cannot read, so it is off. Traces, videos and screenshots are off for the same reason: they
   would capture the typed passwords and the TOTP code.
2. **Environment allowlists.** The simulator and Playwright run under `env -i` with an allowlist (`PATH`, `HOME`,
   `LANG`, `TMPDIR`, and `E2E_STATE_FILE` for Playwright). This is stricter than removing the AWS variables with
   `env -u`: no CI or GitHub variable reaches them either.
3. **Janitor.** The user pool uses `username_attributes = [email]`, so the Cognito `Username` is a UUID, not the e-mail.
   The janitor therefore matches the `email` attribute (`^e2e-<digits>-<digits>@example\.com$`, created more than 2 h
   ago) and deletes by `Username`. The first version matched on the username and found nothing. The janitor reads the
   first page of the listing (60 users), which a run never exceeds, and it is best effort: a failure is a warning.
4. **Simulator teardown.** The setup records the simulator's pid together with its start time (field 22 of
   `/proc/PID/stat`) in the state file right after the launch. The simulator starts with `setsid`, so it leads its own
   process group. Teardown signals the group only when the pid and the start time both match. This prevents a reused
   pid from being signalled, and it stops `uv` and the agent child together.
5. **Report scan.** `scripts/e2e-scan-report.mjs` looks for the two passwords (`temporaryPassword` and `password`) in the
   raw, URL-encoded and base64 forms. It does not scan for the TOTP secret, which is not written to the state file. The
   scan fails closed: a zip or gzip file, or a symbolic link, in the report is a hit. On a hit the report is deleted and
   the job fails.
6. **Enrolment failure.** If the enrolment fails, Playwright's `error-context.md` may contain the TOTP secret. The
   artifact is uploaded after teardown has deleted the user, it is private to the repository, and it is kept seven days.
   Accepted as R97.
7. **Group.** IAM has no condition key for the Cognito group, so the role could add a user to any group. The script
   hard-codes `Operator`. The deploy role already holds `cognito-idp:*` on the same pools, so this role adds no new
   reach over the pool. Accepted as R96 and T62.
8. **Lambda invoke.** `lambda:InvokeFunction` on `mfc-demo-robots` accepts any payload. The robot ids of the test keep
   the form `e2e<run id>a<attempt>-01`, which the scripts check before any call. Accepted as R98.
9. **Runner crash.** The robots function has no list action, so a crashed run can leave one ACTIVE robot whose simulator
   is gone. The cost is about zero (one certificate, one KVS channel). `make destroy` removes it. Accepted as R100.
10. **Dependency.** Playwright is a devDependency of `apps/console` (`@playwright/test`, Apache-2.0), Chromium only. It has
    no install script, so pnpm's build-script policy is unaffected.

The e2e job does not toggle the telemetry queue mapping. ACKs and events reach the cloud through IoT rules that call the
Lambda directly, so the test needs no `lambda:UpdateEventSourceMapping`. The scenario asserts the robot row and the
control flow, not the live position.

## Alternatives considered

| Option                                                    | Pros              | Cons                                                                           | Why not                                                       |
| --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Fake authentication seam of ADR 0051 for the deployed run | No AWS, fast      | The fake token is not a JWT, so the API rejects it; the scenario is not proven | Proves nothing about sign-in, MFA or the API                  |
| Stored test account with a fixed password and TOTP seed   | Simple, reusable  | Long-lived credentials in CI; a leak reaches the real pool                     | Forbidden by the project rules (no stored credentials)        |
| Reuse the deploy role                                     | No new role       | Carries `cognito-idp:*` and `iot:*` for a test                                 | R7: the test must not hold the deploy permissions             |
| Enrol the TOTP factor in a script                         | Less browser code | The UI enrolment goes untested; more code to keep in step                      | The enrolment screen is part of the scenario                  |
| Keep the HTML reporter                                    | Browsable report  | Compressed data the secret scan cannot read                                    | The scan is the control; the list output holds the step names |
| `env -u` for the AWS variables only                       | Smaller change    | CI and GitHub variables still reach the processes                              | An allowlist is the only way to be sure of the environment    |

## Consequences

- The deployed scenario is proven on every push to `main`, with no stored secret. Cost is below USD 0.05 per run (design
  section 6), and the run takes about 8 minutes of runner time.
- The e2e role is a second OIDC role with its own trust. Changes to `infra/bootstrap` that touch it need the
  `security-reviewer` pass (T62). Its tests in `iam.tftest.hcl` pin the subject, the five statements and the exact ARNs.
- The scenario cannot run without AWS. Locally it needs an SSO session of an admin role, the `CONSOLE_URL` of the
  deployment and a local Chromium. A green `make check` does not prove the scenario.
- A new Cognito user is visible in the pool for minutes. The janitor depends on the e-mail shape staying as it is; a
  change to `scripts/e2e-setup.sh` must change the janitor pattern in the same commit.
- Threats added to `docs/security/THREAT_MODEL.md`: T62 (role misuse) and T63 (secret disclosure). Accepted risks R96 to
  R100. The control list is in `docs/security/CHECKLIST.md` (section "E2E and ZAP, M10").
