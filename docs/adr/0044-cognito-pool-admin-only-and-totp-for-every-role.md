# ADR 0044 — Cognito pool: admin-only accounts, TOTP MFA for every role

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-AUTH-1, FR-AUTH-2, FR-AUTH-3 (amended: TOTP for every role), SEC-ID-3, SEC-API-2
- Threats: T3 (sign-in as an operator), T8 (video), R3 (advanced security off). Residual: R49 (deletion protection off)

## Context

The operators sign in to the console with a Cognito user pool. The first draft of FR-AUTH-3 asked for MFA on the
Admin and Operator roles only, and no MFA for Viewer. Cognito applies MFA to the whole pool (`OFF`, `OPTIONAL` or
`ON`), and a per-group rule needs a pre-token-generation Lambda trigger that is one more function to build, test and
secure. The demo has three to five operators, no self sign-up and no SMS budget. A signed-in Viewer can see the live
robot video, which is sensitive (A4), so a Viewer with a weaker sign-in than an Admin would be the weak point.

## Decision

- The pool enforces MFA with `mfa_configuration = ON` and the software token (TOTP) only. The SPEC is amended to read
  "TOTP mandatory for every role". There is no SMS factor.
- Self sign-up is off (`allow_admin_create_user_only`). Accounts are created by `scripts/bootstrap-admin.sh` from an
  SSO session, with a temporary password shown once (S10).
- Passwords are at least 12 characters, with all four classes; a temporary password is valid for one day. Account
  recovery is administrator-only, so there is no e-mail or SMS recovery path.
- The pool runs on the `ESSENTIALS` tier, with `advanced_security_mode = OFF` (R3). The tier carries TOTP and groups,
  and it is inside the free tier for the demo's user count. Deletion protection is off so that `make destroy` works.
- Three groups (`Admin`, `Operator`, `Viewer`, precedence 1 to 3), each with the IAM role of its console role.

## Alternatives considered

| Option                                                        | Pros                           | Cons                                                                                   | Why not                                                                   |
| ------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `OPTIONAL` MFA and a check in the app                         | No pool-wide prompt for Viewer | The app is the only enforcement; a token without the factor is still valid for the API | The API authorizer would accept it. Security over convenience             |
| Pre-token-generation Lambda that refuses a token without TOTP | Per-group rule                 | One more function, its own role, its own tests, a failure mode on every sign-in        | Pool-wide ON gives the same result with no code                           |
| SMS factor                                                    | Familiar to users              | Costs money per message, SIM-swap risk                                                 | TOTP is free and stronger                                                 |
| `LITE` tier                                                   | Cheapest                       | Feature set is closer to the classic pool and changes more often                       | `ESSENTIALS` has the features needed and the same free tier at demo scale |
| Hosted UI                                                     | Managed screens                | Cannot honour the locked design (ADR 0004) and adds a redirect surface                 | The console renders its own sign-in (ADR 0045)                            |

## Consequences

- SPEC FR-AUTH-4 is amended: access and ID tokens last 15 minutes instead of 1 hour, so that a stolen token is useful for less time. The refresh token stays at 8 hours.
- Every operator needs an authenticator app, and the bootstrap runbook includes the QR step. A lost device needs an
  administrator to reset the TOTP factor (`admin-set-user-mfa-preference` or a new account). This is documented in the
  runbook of M6.
- The Viewer role also has MFA. This is stronger than the first draft of FR-AUTH-3 and is recorded as a change of the
  SPEC, not as a silent deviation.
- The pool stays on a one-tier, no-advanced-security configuration. Compromised-credential detection is not available
  (R3). Lockout by Cognito after repeated failures is the only brute-force control on the pool.
- Changing the tier or MFA mode later replaces or updates the pool; the plan of the deploy workflow shows it, and an
  update of the pool in `module.identity` is applied by the CI deploy role only when the plan has no replacement.
