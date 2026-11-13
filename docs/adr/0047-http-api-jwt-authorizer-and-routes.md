# ADR 0047 — HTTP API: JWT authorizer, three routes, per-route throttles and exact CORS origins

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-AUTH-1, FR-AUTH-4, SEC-API-1, SEC-API-3, SEC-API-4, NFR-OBS-1
- Threats: T3 (sign-in and token misuse), T11 (API flood), T14 (role bypass), T16 (over-privileged role), T27 (token
  reuse); accepted risks R1 (no WAF), R42 (no WebSocket log, HTTP API logs without credentials), R48 (ID token as
  bearer), R56 (shared stage throttles), R57 (dev CORS origin)
- Implemented in `infra/modules/http-api`, `infra/envs/demo/api.tf` and `services/api/src/domain/authz.ts` (M6 PR-4).

## Context

The console needs two calls that do not belong to the WebSocket API: the identity of the signed-in operator (`GET /me`)
and the single-use WebSocket token (`POST /ws-token`, ADR 0041). The operator user pool issues both access and ID tokens,
and the browser keeps them in memory (ADR 0045). The demo has no budget for a web application firewall (R1, ADR 0019),
so the API must refuse unauthenticated calls, bound its own request rate and keep logs free of credentials. A liveness
route (`GET /health`) must answer without a token for the health check of the deployment.

## Decision

We expose an HTTP API on the `$default` stage. A JWT authorizer validates tokens against the operator user pool, with the
console app client as audience; `/health` is the only route without an authorizer. Each route has its own Lambda function
and role, and the function refuses any token that is not an access token of the console client (`principalFromClaims`).

- Routes: `GET /health` (no authorizer, own function `mfc-demo-health`), `GET /me` (`mfc-demo-me`) and `POST /ws-token`
  (`mfc-demo-ws-token-http`, same business policy as the IAM-invoked `ws-token` function). Each route has one invocation
  permission, bound to its method and path.
- Throttles: the stage default is 25 requests per second with a burst of 50. `GET /health` is 10 and 20, `POST /ws-token`
  is 5 and 10, `GET /me` takes the default.
- CORS: exact origins only, the CloudFront origin of the console. `http://localhost:5173` is added only when
  `enable_dev_origin` is true (default false). No credentials, methods `GET` and `POST`, `max_age` 600.
- Access logs: JSON, one line per request, with the request id, time, route key, status, latencies, the integration error
  message and the authorizer error. No header, query string, client address or claim is logged. Retention 30 days.
- Alarms: 5xx on the stage, and `Errors` and `Throttles` on each of the three functions, all to the alarm topic (ADR 0023).

## Alternatives considered

| Option                                                     | Pros                                                                    | Cons                                                                                                              | Why not                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| REST API with the Cognito user pool authorizer             | Per-method usage plans and API keys, WAF attachment, request validation | Higher price per request and more configuration; the usage plans throttle per key, which the console does not use | The demo needs three routes and no key management; the HTTP API is enough and cheaper          |
| Lambda authorizer that verifies the JWT itself             | Full control of the claim checks in one place                           | We would own a token verifier, its key cache and its failure modes; a bug there is an authentication bug          | The JWT authorizer verifies the signature and the issuer; our code keeps only the claim checks |
| AWS WAF in front of the API (rate rules and managed rules) | Per-client rate limits and managed rules against common attacks         | Monthly fee per web ACL and per rule, plus a per-request fee; not justified for a demo with no customer traffic   | Deferred (R1, ADR 0019); the per-route throttles and the alarms are the mitigation for now     |

## Consequences

- The gateway refuses a missing, invalid or expired token before any function runs, and a token of another client is refused
  by the audience check. Each function still verifies the claims, so the check does not depend on the gateway alone.
- The authorizer accepts ID tokens too, because they carry the client id in `aud`. The Lambda check (`token_use` must be
  `access`, `client_id` must be present) is therefore the enforcement point. Every new protected route must call
  `principalFromClaims`; the checklist and the denied-access tests (`services/api/test/denied-access.test.ts`) cover it.
- Throttles are shared by the whole stage, not by client. One caller can use the stage budget and slow the others (R56).
  The per-route limits protect the token issue and the health probe, not the other routes.
- Logs without addresses and claims cannot show who called the API. This is the price of keeping credentials and personal
  data out of the logs (R42).
- Each route has its own role and its own invocation permission, so a compromised route cannot call another function
  (T16). A new route is one entry in `api.tf` and one function in its own module.
- The dev origin is plain HTTP and is off by default. It must be off in the demo stack and in the report snapshot (R57).
- Cost: the HTTP API bills per request and the access logs bill per ingested volume; the throttles and the 30-day retention
  keep both small for a demo.
