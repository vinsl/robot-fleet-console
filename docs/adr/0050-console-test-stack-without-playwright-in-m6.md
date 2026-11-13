# ADR 0050 — Console test stack: Vitest with jsdom and Testing Library; Playwright deferred to M10

- Status: accepted
- Date: 2026-11-03
- Requirements: NFR-MAINT-1
- Threats: none directly; the tests are the evidence for T39 to T41 (see THREAT_MODEL.md)

## Context

The console has pure logic (backoff, roles, the WebSocket state machine, the Cognito wrapper) and screens (sign-in,
shell, layout, sheets). The repository rules ask for unit tests on business logic, coverage of at least 80 % on `src/lib`, and a
Playwright end-to-end run of the demo scenario. That scenario needs the deployed stack and the M10 demo data, so it
cannot run in M6. The console is built with Vite, so the test runner should share its configuration and transform.

## Decision

- Tests run with Vitest 5 and the Vite configuration. The default environment is `node`. A component test opts into
  `jsdom` with a `@vitest-environment jsdom` pragma at the top of its file.
- Components are tested with `@testing-library/react`, `@testing-library/dom` and `@testing-library/user-event`, which
  query by role and label and drive the keyboard the way a user does.
- Coverage is measured with `@vitest/coverage-v8` on `src/lib/**`, with an 80 % threshold on lines, functions,
  branches and statements (`apps/console/vitest.config.ts`).
- Playwright is not added in M6. The demo scenario is covered at component level in M6: the sign-in flow, the console
  harness (`test/app`, `test/support`) and the layout components. Playwright returns in M10 with the `make e2e`
  target, against the fixture seam of ADR 0051 and the deployed stack.

## Alternatives considered

| Option                     | Pros                              | Cons                                                                         | Why not                                                        |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Playwright now             | Real browser, real CSS and layout | Browser install in CI, a running stack or the fixture build, slower feedback | Needs the M10 demo data; the M6 risk is in component logic     |
| Jest                       | Mature, large ecosystem           | A second transform and config next to Vite                                   | Vitest reuses the Vite config and runs ESM and TSX natively    |
| happy-dom instead of jsdom | Faster                            | Less complete DOM behaviour for focus and events                             | jsdom is the more conservative choice for accessibility checks |
| Cypress                    | Good developer tooling            | Heavier runner, another language of selectors                                | Playwright is the M10 choice if browser tests are needed       |

## Consequences

- `make check` runs the console unit and component tests with coverage. Layout, colour contrast and the real CSS are
  not checked by jsdom: they are checked by hand on screenshots (`docs/screenshots/`) and by the M10 browser tests.
- The M6 gap is that no browser runs the sign-in against Cognito before M10. The Cognito side is covered by the
  Terraform tests of ADR 0044 and by the unit tests of the real client (`apps/console/test/auth/cognito-client.test.ts`).
- Revisit at M10: add Playwright for the demo scenario and record the decision in a new ADR.
