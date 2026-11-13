# ADR 0041 — WebSocket API: single-use tokens, connect checks and connection limits

- Status: accepted
- Date: 2026-11-02
- Requirements: SEC-API-5, FR-AUTH-4, NFR-COST-1, NFR-REL-1
- Threats: T27 (token), T28 (token issue), T29 (isolation), T30 (frame flood), T34 (fan-out amplification)
- Residual risks: R38, R39, R41, R42, R43 and R44 in THREAT_MODEL.md. Builds on ADR 0039 (fan-out) and ADR 0043 (frame bounds).

## Context

The console reads the fleet over one WebSocket. A browser cannot set an `Authorization` header on a WebSocket, so a
short-lived credential has to travel in the URL or in a subprotocol. Cognito arrives in M6, so in M5 the only caller
able to mint a token is the operator's own AWS session. A stolen token must be useless after one use, a token must
not reveal the site it was issued for to another connection, and a single client must not be able to load the
functions or the socket.

## Decision

- **Routes.** The API has three routes, `$connect`, `$disconnect` and `$default`, and selects the route on
  `$request.body.type`. The `$connect` route has no API Gateway authorizer: the token is checked by the `ws-connect`
  function, because the redemption is the check (the Checkov skip carries that reason).
- **Token issue.** `ws-token` is invoked with IAM only: it has no route and no resource policy. Its event carries the
  principal, the requested site and a correlation identifier. The site must be in the principal's list
  (`FORBIDDEN_SITE`), and the session end must be in the future and at most one hour away (`INVALID_SESSION`). The
  token is 32 random bytes in base64url (43 characters). Only its SHA-256 is stored, with the subject, role, site and
  session end, a TTL of 60 s plus a 60 s grace. `scripts/ws-token.sh` builds the event with a session of 55 minutes,
  prints the URL and the token once, and never logs them.
- **Redemption at `$connect`.** The token shape is checked first. The `Origin` header is checked next, against the
  exact allow-list `ws_allowed_origins` (default `http://localhost:5173`), when the header is present. Then one
  conditional `DeleteItem` (`attribute_exists` and `expiresAtMs > now`, `ReturnValues: ALL_OLD`) consumes the token.
  A refused origin never consumes it. A token that is consumed and then fails to store the connection stays consumed:
  the client asks again (fail closed). Every refusal gives a bare status (401 for the token, 403 for the origin, 500
  for an infrastructure failure), so a caller learns nothing about the check that failed.
- **Connection record.** `CONN#<connectionId>` with the subject, role, site, connection and session times. The
  `sitePk` attribute, which makes the record visible to the `bySite` index, is set only by `subscribe`. The TTL is the
  earlier of the session end and two hours after the connection (the API Gateway cap), plus 60 s.
- **Client frames.** Each `$default` frame is checked in this order: connection record, session end, frame rate, size
  (2 048 bytes, before any parse), then schema. The frame rate is 10 frames per 1 s window per connection, counted by an
  atomic conditional update of the record. A connection over the rate is closed and removed.
- **Subscription.** `subscribe` is accepted only for the connection's own site. A repeated subscribe sends nothing, so
  the snapshot is sent once per connection. Heartbeats are accepted for Admin and Operator and ignored in M5: the lock
  and deadman checks are added at that point in M9.
- **Management endpoint.** `ws-message` builds the callback endpoint from the request context of each event
  (`domainName` and `stage`). The domain name must match the execute-api shape and the region of the function. No
  endpoint is kept in the environment.
- **Stage.** Automatic deployment, no access log and no execution log, no data trace. Stage throttle 50 requests per
  second with a burst of 100, and a `$connect` route throttle of 10 per second with a burst of 20.

## Alternatives considered

| Option                        | Pros                           | Cons                                                                     | Why not                                                                |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Lambda REQUEST authorizer     | Standard place for the check   | One more function; its policy cache does not suit a single-use token     | The redemption is the check; one function fewer                        |
| Cognito JWT on the socket now | No separate token              | Needs Cognito, which arrives in M6                                       | M6 replaces only the principal source (THREAT_MODEL R44)               |
| Token in a cookie             | Browsers send it by themselves | Cross-site WebSocket hijacking; the console has no cookies by design     | The Origin check and the token are the controls                        |
| One route per message type    | Dispatch by the route          | Six integrations and permissions, with no gain in security               | The union is dispatched on the parsed type (ADR 0041, route selection) |
| A separate table for tokens   | Clean separation               | One more resource for 60-second items                                    | Shared table with key prefixes and LeadingKeys (THREAT_MODEL R43)      |
| Endpoint in the environment   | Simple                         | A stage change needs a deploy; the value would be trusted over the event | The request context names the stage that delivered the frame           |

## Consequences

- The token is in the URL, so a proxy or a history can keep it. The 60 s lifetime and the single use limit that
  exposure, and no access log stores the URL (THREAT_MODEL T27, R42). Connects are counted by the handler without the
  token.
- A missing `Origin` is accepted (R41): a non-browser tool holds the token and passes. The token, not the origin, is
  the authenticator.
- Each client frame costs one conditional write. At 10 frames per second at most, and in practice a few per minute,
  this is negligible.
- Session length is set by the caller: 55 minutes in M5 (the script), at most one hour (the handler). In M6 it comes
  from the access token. A disabled user keeps a socket until the session end (R44).
- The stage throttle is shared by all connections (R38). The frame counter is per connection, so one client cannot
  use the whole throttle by itself.
- Connections per site have no cap (R39). The operator is the only minter of tokens until M6.
