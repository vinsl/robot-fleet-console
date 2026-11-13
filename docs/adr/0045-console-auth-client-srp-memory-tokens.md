# ADR 0045 — Console auth client: SRP through the Cognito SDK, tokens in memory only

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-AUTH-1, FR-AUTH-2, SEC-WEB-2, SEC-ID-3, SEC-API-5
- Threats: T3 (credential stuffing and sign-in), T8 (video), A3 (sessions); token theft through XSS (CSP, ADR 0046)
- Implemented in PR-5 (console auth client). The app client it talks to is defined in `infra/modules/identity`.

## Context

The browser signs operators in against the public app client of ADR 0044. The password must never leave the browser
in clear, the session must not survive a reload, and the design is locked (ADR 0004): no hosted sign-in page can
replace the console's own screens. The console needs TOTP setup, which means showing the secret and an
`otpauth://` URI, and the first-login new-password challenge. The tokens are bearer credentials for the API and the
WebSocket, so their storage is the main client-side risk.

## Decision

- The console uses `amazon-cognito-identity-js` (MIT). It runs the SRP exchange, the new-password challenge, the
  TOTP setup and verification and the refresh flow. No password is sent in clear and no `USER_PASSWORD_AUTH` flow
  is used.
- Tokens (access, ID and refresh) live only in the closure of the auth client. The library is given an in-memory
  `Storage` shim, because its default is `localStorage`. Nothing is written to `localStorage` or `sessionStorage`
  for a token. The only persisted value is the language (`mfc.lang`).
- A reload signs the operator in again (SEC-WEB-2). The access token is refreshed when less than 60 seconds remain,
  with one refresh in flight at a time.
- The role shown in the UI comes from the `cognito:groups` claim with the highest-role-wins rule. The UI never
  decides authorisation: the API and the WebSocket check the claims again (ADR 0041).

## Alternatives considered

| Option                                     | Pros                          | Cons                                                                   | Why not                                      |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Amplify Auth                               | Full toolkit, managed storage | Large bundle, opinionated storage and UI helpers, more to audit        | The console needs four calls, not a toolkit  |
| Hosted UI with the authorisation code flow | No password code in the app   | Cannot honour the locked design; a redirect and a callback surface     | ADR 0004 and the redirect risk               |
| Hand-written SRP                           | No dependency                 | Cryptographic code written by hand: the worst place to be original     | Use the library the vendor ships             |
| Tokens in `localStorage`                   | Survives a reload             | Any script on the page reads them (XSS)                                | Memory only is the control (THREAT_MODEL T3) |
| HttpOnly cookie for the tokens             | Not readable by script        | Needs a server session and CSRF handling; the WebSocket cannot send it | The API is stateless by design (ADR 0041)    |

## Consequences

- Reloading the page or closing the tab ends the session, so an operator signs in again each time. Acceptable for a
  console of this kind, and it limits the exposure of a stolen device.
- An XSS on the page can still use the tokens while the page is open. The CSP with no inline script and no `eval`
  (SPEC SEC-WEB-1) is the first control; the short access-token life (15 minutes) limits the rest.
- The library is a runtime dependency of the console. Its maintenance is checked at the M6 PR (PR-5) and its licence
  is MIT.

The library is in AWS maintenance mode, so no new feature is expected from it.
The console suppresses the `@typescript-eslint/no-deprecated` rule for `apps/console/src/auth/cognito-client.ts` only,
with a comment that gives the reason; the rule stays on for every other file. This is accepted until 2026-12-01. On
that date the team records in a new ADR either the decision to keep the library, with its suppression, or the
migration of the four calls the console makes (SRP sign-in, new password, TOTP and refresh) to a supported package.
