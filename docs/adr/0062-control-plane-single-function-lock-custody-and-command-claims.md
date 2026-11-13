# ADR 0062 — Control plane: one `control` function, cloud-held lock token, command claims and a policy table

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-CMD-1, FR-CMD-2, FR-CMD-5, FR-AUTH-1, FR-SITE-1, SEC-API-1, SEC-API-2, SEC-API-3, SEC-CMD-1, SEC-IAM-1
- Threat: T50, T52, T53, T54 (route throttles only), T59, R92
- Implemented in (planned, M9): `services/api/src/domain/control/*.ts`, `services/api/src/handlers/control.ts`,
  `services/api/src/adapters/dynamodb-lock.ts`, `services/api/src/adapters/dynamodb-control-state.ts`,
  `services/api/src/adapters/iot-publisher.ts`, `packages/protocol/src/control.ts`, `infra/envs/demo/control.tf`

## Context

M9 adds the commands an operator sends to a robot (pause, resume, return to base, e-stop, e-stop release), the
control lock that says who may send them, and the list of robots the panel needs. Five forces shape the design:

- The robot checks `(lockToken, issuedBy)` on every lock-required command (ADR 0028). The token is the only proof the
  robot accepts that the sender holds the lock, so it must not be leaked to a place where another party can read it.
- Commands and the lock use the same resources: the lock item, the registry read, the audit write, the fan-out and
  `iot:Publish` on the robot's `cmd` topic. Two Lambda roles with the same statements add Terraform and no isolation.
- Two operators can ask for the lock in the same second. The write must arbitrate, and a lost race must never reach
  the robot.
- A captured request or a retried publish must not act twice (SEC-CMD-1, T53). A phone with a skewed clock must not
  fail every command, so the console's clock is not trusted.
- The HTTP API integration timeout is 5 s, and the robots function is in the same account with the IoT and KVS rights.

## Decision

- **One function, `mfc-demo-control`.** It serves the robot list, the lock (get, acquire, release), the command route and
  the demo flag (get, put, ADR 0065). Its role carries the union of the rights those routes need, scoped to the site
  keys and the `cmd` topics. The audit reader and the WebSocket heartbeat path keep their own roles, because their rights
  differ (SEC-IAM-1). SPEC 4.3 named two functions, `commands` and `control-lock`; they are merged.
- **Lock token custody in the cloud.** The lock item `SITE#{site}` / `LOCK#{robotId}` holds `holder` (the verified
  `sub`), `token` (32 random bytes, base64url), `acquiredAt` and `expiresAt` (epoch seconds, the table TTL attribute).
  The token is never returned in a response, a frame or a log. The cloud injects `lockToken` and `issuedBy = holder sub`
  into the command it publishes, and only after it has checked that the caller is the holder and that the lock has not
  expired. The browser proves that it holds the lock by its verified identity, and the robot still compares the pair.
- **Acquire order.** One conditional `PutItem` (`attribute_not_exists(pk) OR expiresAt <= now OR holder = me`), then the
  `TAKE_CONTROL` publish, then the `lock.changed` fan-out, then the audit record. If the publish fails, the item is
  deleted with a condition on the token and the API answers 502 `upstream-failed`.
- **Expiry is checked explicitly.** `expiresAt` is the last holder activity plus 30 s. Every read and write compares it
  with the clock, because the table TTL deletion can lag by up to 48 h. Holder commands refresh it, and so do heartbeats
  at most every 10 s (ADR 0063).
- **Command identity and claims.** The console mints `commandId` (UUIDv7) before it sends. The function claims
  `CMD#{commandId}` in the fleet table with a conditional put and a TTL of 1 h. The same actor, robot, type and params
  again return 200 with `deduplicated: true` and publish nothing. Other values for the same id return 409
  `command-conflict`. If the publish fails, the claim is deleted on a best-effort basis. If that cleanup fails, the
  claim stays for at most 1 h, and the console sends the next attempt with a new `commandId`.
- **Replay windows.** HTTP leg: the access token lives 15 min and the claim lives 1 h. MQTT leg: `issuedAt` is the server
  clock at publish time, and the robot accepts a window of 2 s and keeps an LRU of ids (ADR 0027). No client timestamp
  is trusted.
- **Policy table.** One pure table, `COMMAND_POLICY`, maps each command type to its roles, `needsLock`, `needsDemoMode`,
  `needsSimulated` and its audit action. PAUSE, RESUME, RETURN_TO_BASE and ESTOP_RELEASE need the lock. ESTOP needs no
  lock. SIMULATE_FAULT needs Admin, demo mode on and a simulated robot. TAKE_CONTROL and RELEASE_CONTROL go only through
  the lock routes, HEARTBEAT only through the WebSocket, and DRIVE is refused by the schema. A test compares `needsLock`
  with the protocol's `LOCK_REQUIRED_COMMANDS`.
- **Publish contract.** IoT data plane `Publish`, QoS 1, one attempt (`maxAttempts: 1`), 2 s connect and 2 s request
  timeouts. The payload is parsed with `CommandSchema` and must be at most `MAX_MQTT_PAYLOAD_BYTES` (4096) before it is
  sent. ESTOP publishes before its audit record (ADR 0064).
- **Release is a POST.** `POST .../lock/release` replaces the SPEC's `DELETE .../lock`, because the HTTP API CORS allows
  GET, POST and PUT only, and adding DELETE would change the module for one verb.
- **Routes are site-scoped** (`/sites/{siteId}/...`, ADR 0047 and ADR 0061). Each route has its own throttle at the
  gateway (commands 10 per second with a burst of 20, lock 5 with a burst of 10).

## Alternatives considered

| Option                                                  | Pros                            | Cons                                                                             | Why not                                                                         |
| ------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Two functions, `commands` and `control-lock` (SPEC 4.3) | Each role is narrower on paper  | The same statements twice: two roles, two Terraform blocks, no isolation gain    | SEC-IAM-1 is met by resource-scoped statements in one role                      |
| Return the lock token to the browser and send it back   | The cloud keeps no secret       | A bearer secret in the browser: a leak through XSS, devtools or a log; more code | The holder check on the verified identity is stronger and the client is simpler |
| Publish first, then write the lock                      | Simpler code path               | A lost race between two operators reaches the robot                              | The write is the arbiter; a failed write never publishes                        |
| Powertools idempotency with its own table               | A library does the work         | A table and a dependency for one conditional put; SPEC 8 row not created         | One conditional put gives the same guarantee and reads clearly                  |
| `clientTs` window on the HTTP body                      | Early rejection of old requests | A phone with a skewed clock fails every command                                  | The server clock is the only clock the robot compares                           |
| `DELETE .../lock` for release                           | Matches REST wording            | CORS and module change for one verb                                              | `POST .../lock/release` needs no infra change                                   |
| SDK retries on publish                                  | Fewer visible failures          | A retried publish after an ACK makes the robot answer `REJECT DUPLICATE`         | One attempt: a failure is a clean 502 and the console sends a new attempt       |

Per-user rate limiting is not in the M9 scope. It is listed in `docs/ROADMAP.md`, so the route throttles above are the
only command limit in M9.

## Consequences

- One role reviews the whole command path, and its tests (the denied-access table in `services/api/test/`) cover every
  refusal before any store call. A defect in this function reaches every command, so it gets the strictest review.
- The lock token exists only in the lock item and in the published command. A lost lock item (TTL, or a crash between
  the write and the publish) makes the holder's next command fail with `lock-not-held`, and the console asks for the
  lock again.
- A command that publishes and then fails to write its audit record leaves no audit line; the decision is kept by the
  logs (ADR 0064, R84).
- A failed claim cleanup leaves a stale `CMD#` item for at most 1 h (R92). The console never reuses a `commandId` after a
  failure.
- The cost is a few DynamoDB writes and one publish per command, which is negligible at demo scale.
- Accepted: an Admin cannot force-release another operator's lock (R91, `docs/security/THREAT_MODEL.md`).
