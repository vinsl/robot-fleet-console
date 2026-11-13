# ADR 0076 — Operator and Viewer accounts from the local demo page

- Status: accepted
- Date: 2026-11-04
- Requirements: none in SPEC (bonus J in `docs/ROADMAP.md`); SEC rules of `docs/security/CHECKLIST.md`
- Amends: [ADR 0071](0071-local-demo-control-server.md), the sentence that the page never writes to Cognito
- Implemented in: `agent/src/fleet_agent/demo_ui/` (`accounts.py`, `server.py`, `errors.py`, `config.py`, `__main__.py`,
  `static/`), `agent/tests/demo_ui/`, `docs/security/THREAT_MODEL.md` (T70, T71, R104), `docs/security/CHECKLIST.md`,
  `docs/security/RUNBOOK_DEMO.md`. `scripts/bootstrap-admin.sh` is used as it is.

## Context

Console accounts are created with `make bootstrap-admin`, a terminal command. Before a live test the operator adds an
Operator and a Viewer, and the test itself runs in the demo page, so the operator switches to a terminal and copies a
temporary password by hand. The script already handles the password safely: openssl generates it, the Cognito input
goes through a private file rather than argv, and a reset signs the account out of every session (THREAT_MODEL T36,
T37). Rewriting that handling in Python would add a risk before the demo. The demo page already runs with the operator's
SSO session and already lists the users, so it can run the same script with the same session. The deployed console
gets no route, no IAM role and no infrastructure change for this (ADR 0071).

## Decision

The demo page has an "Operator accounts" form. It creates an Operator or a Viewer account, or resets one, by running
`scripts/bootstrap-admin.sh` through the page's own command runner. The request is synchronous: the temporary password
is returned only in the response to that request, shown once on the page, and stored nowhere on the server. The page
never accepts Admin, never adds a group to an existing account, and refuses a reset of an Admin, of an account with no
group or with a disabled one, or with a role that differs from the account's group. A write first reads the user list
and is refused when the pool holds 200 rows or more. A reset needs a confirm step, and the server allows one write at a
time and at most five writes in ten minutes.

The script itself is not changed. The page always sets `ROLE`, so the script's default of Admin for a new account is
never used.

## Alternatives considered

| Option                                                               | Pros                        | Cons                                                                                                           | Why not                                                                                                           |
| -------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Call Cognito from Python (`AdminCreateUser`, `AdminSetUserPassword`) | One language, no subprocess | Rewrites the password handling the script already gets right, and keeps a second copy of the rules to maintain | The script is the reviewed path (T36, T37); a rewrite is a new risk in the week of the demo                       |
| Asynchronous job with polling and a stored result                    | The request returns at once | The temporary password must be kept on the server until the page reads it                                      | A secret that is never stored is the stronger control, and a write takes a few seconds                            |
| Admin creation on the page as well                                   | One form for every role     | An Admin created from a local page is a path to full control of the console                                    | Admin stays in the terminal command, which needs a typed command and the operator's session                       |
| Keep the terminal command only                                       | No new code path            | Two terminal steps and a hand copy of the password during the live test                                        | The page already holds the session and the list; the terminal stays available for Admin                           |
| `pydantic[email]` for the e-mail check                               | Standard validation         | A new dependency (`email-validator`) for one check                                                             | A short ASCII grammar with a full match is enough, and it refuses a leading `-` that the CLI would read as a flag |

## Consequences

- Easier: the live test adds its Operator and Viewer accounts from the page, with the script's password handling. No infrastructure
  change, no route on the deployed console and no new IAM action: the writes use the Cognito actions that
  `make bootstrap-admin` already needs.
- Harder: the page is now a write path to the user pool. Anyone with the page token can create an Operator account, as
  anyone with the SSO session can (R104, R102). The e-mail address appears in the script's argument list, as it does with
  `make bootstrap-admin`. The account list and the new e-mail addresses must be blurred in screenshots.
- Security: the password leak is T70 and the privilege paths are T71. Each control has a test in `agent/tests/demo_ui/`,
  listed in `docs/security/CHECKLIST.md`. The residual risk is R104.
- Cost: no new AWS resource. Each account is one user in the pool, the same as an account created in the Cognito console.
- ADR 0071 said that the page never writes to Cognito or DynamoDB. That sentence is amended: the page writes to Cognito only
  through `scripts/bootstrap-admin.sh`, for Operator and Viewer accounts, and it still never writes to DynamoDB.
