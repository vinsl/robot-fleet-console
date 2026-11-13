# ADR 0051 — End-to-end fake authentication seam: build flag, mode guard and dist scan

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-AUTH-3, NFR-MAINT-1, SEC-WEB-1, SEC-WEB-2
- Threats: T40 (fixture accounts reach production), T39 (tokens in browser storage)
- Implemented in PR-5 (console shell): `apps/console/src/auth/fake-auth-client.ts`, `apps/console/vite.config.ts`,
  `apps/console/src/main.tsx`, `scripts/check-console-fixtures.mjs`

## Context

The M10 browser test signs in as a fixed user and must not need a real TOTP device or a live Cognito pool for each
run. The test needs a seam in the console, and the seam is a risk: a fixture account in a published bundle would be a
known password and a known TOTP code. The seam must be impossible to enable by mistake, and a production bundle must
prove that it does not contain it.

## Decision

- `fake-auth-client.ts` implements the same `AuthClient` interface as the real client. Three fixture accounts, one
  password and one TOTP code. Its state lives in the page, so a reload signs the user out, as in production.
- `main.tsx` imports the fake only when `import.meta.env.VITE_E2E === "true"`. `vite.config.ts` turns the variable into
  a constant at build time. In every other build the import is dead code and is removed by the bundler.
- `vite.config.ts` throws when `VITE_E2E=true` is set outside `--mode e2e`, so a build with the flag in the wrong mode
  fails instead of producing a bundle with fixtures.
- `scripts/check-console-fixtures.mjs` scans the built `dist` for the marker `mfc-e2e-fixture-v1` and fails when it is
  found. A unit test in `scripts/check-console-csp.test.mjs` checks that the script's marker equals the one in the fake.
  `make check-ts` runs the scan after the production build.

## Alternatives considered

| Option                                            | Pros                             | Cons                                                       | Why not                                                      |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Runtime flag in `config.json`                     | Switchable without a rebuild     | A published config could enable fixtures in production     | The flag must be fixed at build time                         |
| Vite alias to a fake module in the e2e build only | No flag in the code              | Easy to misconfigure, and no check on the output           | The guard and the scan are the controls; the alias adds none |
| Real Cognito test user with a real TOTP secret    | Tests the real client end to end | A live pool and a stored TOTP secret in CI; slow and flaky | Kept for M10 only if needed; the seam covers the UI flows    |
| Network mock (Mock Service Worker)                | No code in the app               | A dependency and a mock worker shipped to the browser      | More surface than an in-app client for four calls            |

## Consequences

- The production bundle contains no fixture: `make check-ts` finds no marker in `apps/console/dist` (checked on
  2026-11-03).
- The fixture access token is not a JWT, so the API rejects it. The seam covers the sign-in screens and the shell, not
  the API calls. The API is covered by its own tests (ADR 0047).
- The fixture password and TOTP code are public by design, and they open nothing outside the console. They must never
  be copied into a real account or a real pool.
- A developer who runs `make dev` with `VITE_E2E=true` in dev mode gets the fixtures. The mode guard applies to the dev
  server too, so the command needs `--mode e2e` (see the Console section of the top-level README).
