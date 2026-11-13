# ADR 0007 — Lambda runtime: Node.js 24 on ARM64 with esbuild and Powertools

- Status: accepted
- Date: 2026-10-31
- Requirements: SEC-SUP-1, NFR-MAINT-1, NFR-COST-2, SPEC §4.3

## Context

SPEC §4.3 asks for the latest Node.js LTS runtime supported by Lambda, on ARM64, bundled with esbuild, and
with Powertools for AWS Lambda. The AWS runtimes page (checked on 2026-10-31,
https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) gives these deprecation dates:

| Runtime    | Block create | Block update | Deprecation |
| ---------- | ------------ | ------------ | ----------- |
| nodejs24.x | 2028-06-01   | 2028-07-01   | 2028-04-30  |
| nodejs22.x | 2027-07-29   | 2027-08-31   | 2027-04-30  |

Before this change `.nvmrc` pinned Node.js 22. The file is read by the CI jobs, the Terraform plan job, the
deploy job and the e2e job, and by Dependabot for `@types/node`, so the version changes in all of them at once.

## Decision

- Lambda functions use `nodejs24.x` on `arm64`.
- esbuild bundles each function with its dependencies, including the AWS SDK for JavaScript v3, so the
  SDK version is the one in the lockfile and not the one the runtime happens to ship.
- Powertools for AWS Lambda provides the logger, metrics, tracer, idempotency and the zod parser.
- `.nvmrc` moves from 22 to 24, together with the README prerequisite that names the Node.js version. This
  change is part of the branch that carries this ADR, not part of the ADR text.
- Fallback: if the CI breaks on Node 24 in a way that cannot be fixed quickly, return `.nvmrc` and the
  Lambda runtime to 22. The runtime deprecation of 22 (April 2027) is then the next deadline.

## Alternatives considered

| Option                   | Pros                                    | Cons                                                                   | Why not                                                              |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| nodejs22.x               | Already the value of `.nvmrc`           | Deprecation on 2027-04-30, one year before 24                          | The deadline comes sooner, and the stack would need a second upgrade |
| nodejs26.x               | Newest line listed by the runtimes page | Newer line with less time in use; no deprecation date is scheduled yet | Revisit when it is an LTS line and the build is still running        |
| Runtime SDK, no bundling | Smaller deployment package              | The SDK version follows the runtime; more deployment drift to explain  | Pinned bundles are reproducible from the lockfile                    |
| x86_64 instead of arm64  | Wider tooling support                   | Higher price per duration unit for the same work                       | ARM64 is the SPEC choice (NFR-COST-2)                                |

## Consequences

- Every change that moves the runtime or `.nvmrc` must update the Lambda code, the CI jobs and the README in
  the same PR.
- `@types/node` follows the Node.js major of `.nvmrc` (`.github/dependabot.yml`), so it moves with this
  decision.
- Each dependency adds to the bundle size; esbuild includes only the modules that are imported.
- The runtime choice is not made on price. It has no effect on the budget of NFR-COST-1.
