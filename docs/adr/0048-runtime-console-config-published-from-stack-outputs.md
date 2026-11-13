# ADR 0048 — Runtime console configuration: `/config.json` written by the publish script from the stack outputs

- Status: accepted
- Date: 2026-11-03
- Requirements: M6 console foundation; no secret in the public bundle
- Threats: T38 (tampered build or configuration), accepted risk R55 (CI can write the console bucket)
- Implemented in `scripts/publish-console.sh` (M6 PR-6), read by the console at boot (M6 PR-5).

## Context

The same console build must run against the demo stack, and against any stack rebuilt later, without a code change.
The values it needs are the API and WebSocket URLs, the region, the user pool, the app client and the identity pool.
They are created by Terraform, so they are known only after a deploy. A value baked into the bundle at build time
would tie the artefact to one stack and would force a rebuild for every deploy.

## Decision

- `scripts/publish-console.sh` reads the Terraform outputs of `infra/envs/demo` and writes `config.json` next to the
  build. Its keys are `apiUrl`, `wsUrl`, `region`, `userPoolId`, `userPoolClientId` and `identityPoolId`.
- Every output is checked against a pattern before it is used, and the script stops when one is missing. The file holds
  public identifiers only: no key, no token, no credential, no account id.
- The console fetches `/config.json` once at boot with `cache: "no-store"` and validates it with zod. A wrong or missing
  file stops the console with a typed error; it never falls back to a guessed value.
- The upload puts `config.json` and `index.html` with `Cache-Control: no-cache`, and only then invalidates both paths in
  CloudFront. Hashed assets carry `immutable` caching.
- The publish runs from the operator's IAM Identity Center session, not from CI (R55 for the grant that CI keeps).

## Alternatives considered

- Vite build-time variables (`VITE_*`): simple, but the bundle would differ per stack and every deploy would need a
  rebuild. CI would also need the stack outputs, which widens its reach.
- A configuration endpoint on the API: it would need an authenticated call before sign-in, which does not exist yet,
  and one more route to protect.
- A configuration file committed to the repository: it would hold account-specific identifiers in git.

## Consequences

- A change to the configuration keys is a change to the console and to the publish script together, in one PR.
- The file is public. Anyone who can read the console can read it, so it must never gain a secret; the publish script
  and the zod schema are the two places that enforce this.
- A stack that has been redeployed needs `make publish-console` again, or the console keeps the old identifiers.
