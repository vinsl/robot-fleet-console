# ADR 0032 — Lambda packaging, the lambda-function module and IAM policies as locals

- Status: accepted
- Date: 2026-11-02
- Requirements: NFR-MAINT-1, NFR-OBS-1, SEC-IAM-1, SEC-SEC-1, T16, R26

## Context

Every Lambda of the demo must follow the same repository rules: its own least-privilege role, a permissions
boundary, a log group of seven days, active tracing, arm64, an explicit timeout, and a dead-letter queue when it is
asynchronous. Two functions exist in P3 and more follow in M5 and M6, so these rules must sit in one place that tests
can read. The bundles come from the TypeScript build of `services/api` (esbuild, `dist/<name>/index.mjs`), and the
deploy workflow is the only path that builds and ships them (ADR 0021). The Terraform tests run with mocked providers
(`mock_provider`), which do not evaluate data sources, so the content of a policy cannot be asserted when it is built
by `aws_iam_policy_document`. The bootstrap root already builds its policies with `jsonencode()` of locals for that
reason.

## Decision

- **One module per Lambda: `infra/modules/lambda-function`.** It creates the execution role (path `/mfc-demo/`,
  boundary of the workload), the business policy passed in as JSON, a runtime policy scoped to the function's own log
  group plus the X-Ray write actions that have no resource type, a log group of seven days, the function on
  `nodejs24.x` and `arm64` with active tracing, an explicit timeout, and an event invoke config. A dead-letter queue is
  passed only by asynchronous functions; a synchronous function passes none (ADR 0029).
- **Bundles are archived from the build.** `archive_file` packs `services/api/dist/<name>/` into the deployment
  archive. The bundle is built by the deploy job from `main` and is not signed (code signing is deferred, accepted
  risk R26).
- **Policies are `jsonencode()` of locals.** Every business policy and every IoT policy is a `jsonencode()` of an HCL
  object in `locals` (`infra/envs/demo/iam.tf`, `infra/modules/robot-iot/main.tf`). The `$${...}` escapes keep IoT
  and KVS variables literal. The tests read these locals with the mocked provider and assert the exact actions and
  resources (`robots.tftest.hcl`, `robot_iot.tftest.hcl`). The coder guidelines name `aws_iam_policy_document`
  instead; that data source cannot be read by the mocked tests, so a wrong statement would pass them. This is a
  deliberate deviation for the Terraform of the robot stack.
- **No VPC.** The functions reach AWS over public endpoints (ADR 0008). The invoke permission of a function is granted
  by the module that owns its caller: the IoT rules module grants it to the ingest function (ADR 0031), and the robots
  function has none, because only the operator's IAM session invokes it (ADR 0029).

## Alternatives considered

| Option                                 | Pros                                      | Cons                                                             | Why not                                                    |
| -------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `aws_iam_policy_document` data sources | Native HCL syntax, linted by the provider | Not readable by mocked tests, so their assertions would be empty | The tests of ADR 0032 must see the statements              |
| Zip in the build script                | One tool fewer in Terraform               | Two places decide the runtime settings of a function             | The module enforces the rules of the repository rules once |
| One Terraform block per function       | Less indirection                          | The rules are copied, and a copy can drift from the others       | One module, tested once                                    |
| Serverless Framework or CDK            | Higher-level constructs                   | A second infrastructure tool next to Terraform (ADR 0005)        | One IaC tool for the whole repository                      |

## Consequences

- A new function is one module call with a business policy, and it inherits the logging, tracing and boundary rules.
  The module tests (`lambda_function.tftest.hcl`) refuse a name outside the demo prefix, a timeout above one minute, a
  role path other than `/mfc-demo/`, and more than two retries.
- The policy locals are checked by their tests, not by the provider's schema checks, so a new action must come with a
  test that names it. `tflint` and `checkov` run on the rendered resources.
- Without code signing, a compromised deploy workflow could ship any bundle. The protection is the deploy workflow
  itself, from `main` only (ADR 0020, THREAT_MODEL R26).
