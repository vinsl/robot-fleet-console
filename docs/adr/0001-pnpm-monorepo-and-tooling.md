# ADR 0001 — pnpm monorepo and shared tooling

- Status: accepted
- Date: 2026-10-31
- Requirements: NFR-MAINT-1, SEC-SUP-1

## Context

One developer, a one-week deadline, and one repository that holds the React console, the Lambda
API, the shared protocol and the infrastructure code. The protocol schemas are trust boundaries
(zod, validated at every input), so each schema must exist in one place only. The Python robot agent
has its own toolchain (uv, Ruff, mypy) and is not part of the JavaScript workspace. Dependency
installs must be reproducible and must not run untrusted install scripts.

## Decision

- pnpm workspaces over `apps/*`, `services/*` and `packages/*`, with one lockfile at the root.
- `@mfc/protocol` is a private package whose `exports` points at `./src/index.ts`. Vite (console),
  Vitest, tsx (protocol generators) and, from M2, esbuild (Lambda bundles) consume the TypeScript
  source directly. There is no `dist` build for the protocol and no build step before tests.
- Shared compiler options live in `tsconfig.base.json` with `module: preserve` and
  `moduleResolution: bundler`. Relative imports have no file extension (`./ids`, not `./ids.js`).
- TypeScript is pinned to exactly `6.0.3` in the root and in each package. typescript-eslint 8.71.2
  declares the peer range `typescript >=4.8.4 <6.1.0`, so TypeScript 7 cannot be used with the
  current lint stack. Dependabot does not propose TypeScript major upgrades (`.github/dependabot.yml`).
- Linting: ESLint 10 flat config with typescript-eslint `strictTypeChecked` and
  `eslint-plugin-security` (recommended), `--max-warnings=0`.
- Unit tests: Vitest with the v8 coverage provider. Thresholds are 80 % (lines, functions, branches,
  statements) on `packages/protocol/src` and on `services/api/src/domain`.
- Python agent: uv for the environment and lockfile, Ruff for format and lint, mypy `--strict`,
  pytest with `fail_under = 80`. The agent is outside the pnpm workspace.
- `make check` runs the same commands as the CI workflows. Pre-commit and pre-push run the fast subset.

## Alternatives considered

| Option                                                | Pros                                                            | Cons                                                                                                                                      | Why not                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Nx                                                    | Task graph, computation cache, affected-only runs               | Generators, plugins and a project graph to learn and maintain for four packages                                                           | The repository is small; `pnpm -r` covers the need. Revisit if CI time becomes the bottleneck                    |
| Turborepo                                             | Simple pipeline file, remote cache                              | Remote cache is an external service; the pipeline adds a layer over scripts that already work                                             | Same reason as Nx, and the remote cache would need an account and a trust decision                               |
| Separate repositories (console, API, protocol, agent) | Independent release cycles and permissions                      | The protocol would be versioned and published across repositories; schemas would be duplicated or released in lock-step by hand           | Breaks the rule that each schema exists once. Not worth the coordination for one developer                       |
| npm workspaces                                        | Built into npm, no extra tool                                   | No equivalent of the pnpm settings used here (`minimumReleaseAge`, `strictDepBuilds`, `onlyBuiltDependencies`) in the same workspace file | The supply-chain controls are part of the security gate (ADR 0002)                                               |
| Build `@mfc/protocol` with `tsc` into `dist`          | Consumers see plain JavaScript and `.d.ts`; works with any tool | Every test and dev loop needs a build first; `dist` can go stale; two copies of the code to keep in step                                  | Source export keeps one copy and no build order. The only consumers are our own tools, which all read TypeScript |

## Consequences

- Tests and the dev server start without a build step for internal packages.
- Runtime code must go through a bundler or a TypeScript loader (Vite, Vitest, tsx, esbuild). Running
  `services/api` source directly with plain `node` will not resolve extensionless imports. This is
  intended: Lambda code is bundled by esbuild.
- The packages are not published, so the bundler-only resolution has no consumer outside this repository.
- A TypeScript upgrade is a deliberate change across all packages, done by hand.
- Dependency installs run with `--frozen-lockfile` in CI. pnpm refuses versions published less than
  14 days ago (`minimumReleaseAge: 20160`, in minutes) and runs only the install scripts listed in
  `onlyBuiltDependencies` (`esbuild`). This limits exposure to a compromised release.
- The Python lockfile (`agent/uv.lock`) is separate. Its 14-day rule is `exclude-newer` in
  `agent/pyproject.toml`.
- No AWS cost and no runtime effect: this is a build and development decision.
