# ADR 0036 — Agent local video service: loopback server, fragment claim token, awscrt x509 provider, video isolation probe

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-6, FR-VID-1, FR-VID-2, FR-VID-3 (master side only), SEC-ID-2, SEC-SEC-1, SEC-WEB, NFR-OBS-1, NFR-COST-1
- Threats: T1, T2, T8, T9, T20, T22, T24, R36

## Context

The robot's camera must reach the operator through Kinesis Video Streams (KVS) WebRTC, and the robot agent is the
KVS master. Three forces shape the design. First, the robot agent is a safety core: a webcam, a browser page or a
credentials call must never stop telemetry, the state machine or the e-stop (a side service that fails is logged and
the robot keeps running). Second, the master needs temporary AWS credentials that are scoped to the robot's own
channel, and the agent must not write them, or the key that protects the page, to disk (SPEC 4.1, T2, T9). Third, the
page is reachable by any local process and by any web page that the operator's browser visits, so it must refuse
DNS rebinding, cross-site requests and token guessing (T24). The M4 gate also needs a check, run with the robot's own
video identity, that the robot cannot open another robot's channel (T8).

## Decision

The agent runs a **local video service** (`agent/src/fleet_agent/video/`), started beside the core as an optional
side service, with these parts:

- **Loopback only.** The page listens on `127.0.0.1` on an ephemeral port and answers only peers on the loopback
  address. The port is logged, the address is not.
- **Fragment claim token.** At start the agent prints one 43-character single-use token, valid for 15 minutes, in an
  address of the form `http://127.0.0.1:<port>/#claim=<token>`. The page reads the token from the fragment, removes it
  with `history.replaceState`, then sends it in a `POST /api/claim` body. A fragment is never sent in a request line,
  so the token never reaches a server log, a `Referer` or the browser history. The body is `{"claim": "<text>"}` and is
  checked as a plain dict by the application (`_claim_value` in `app.py`), not as a protocol schema: the claim is a
  local, internal request that has no wire format in the protocol, and the check is exact (one key, text, bounded
  size).
- **Session key.** A correct claim returns a 43-character session key, once. The page keeps it in memory and sends it as
  `Authorization: Bearer` on `GET /api/session` and `GET /api/status`. The key has no idle expiry. Five wrong tokens lock
  the claim, and `SIGUSR1` re-arms it: the current key is revoked, a new token is printed, and the failure count resets.
- **Credentials through the awscrt x509 provider.** The agent builds `AwsCredentialsProvider.new_x509` from the kit's
  PEM bytes (`ClientTlsContext` built with `create_client_with_mtls`, trust store overridden with the kit's root CA),
  with the robot's thing name and role alias. The provider sends `x-amzn-iot-thingname` itself, which the IAM condition
  `credentials-iot:ThingName` needs. The credentials are fetched again 20 minutes before expiry. A result with less than
  5 minutes of validity is a failure. Failures back off from 2 s to 60 s, and each call is limited to 15 s.
- **Own HTTP/1.1 server.** The service uses `asyncio.start_server` with no third-party framework. It serves exact paths
  from a fixed table (five routes), closes every connection after one answer, caps request line, head and body sizes,
  reads with deadlines, and allows 16 connections at once. A request outside the parser limits gets its status and a
  problem body with no internals.
- **Request checks, in a fixed order:** rate (30 requests per second sustained, burst 60, `429` with `Retry-After`), Host
  (exactly `127.0.0.1:<port>`), `Sec-Fetch-Site` (only `same-origin`, and `none` for the index page only), route, then
  the route's own checks. A claim needs an exact `Origin` and a JSON content type. Responses carry `Cache-Control:
no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a Content-Security-Policy with `frame-ancestors
'none'`, and a Permissions-Policy that grants the camera to this page only. No CORS header is sent.
- **Static files from an allowlist.** The page's files are loaded into memory at start from the committed manifest
  (ADR 0037). Each file is checked against its SHA-256; a mismatch, a missing file or an unlisted file on disk disables
  the page. Requests are answered by exact dictionary lookup, so no path from a request reaches the filesystem.
- **The video service is optional and never raises.** `FLEET_VIDEO_ENABLED` (default `true`) switches it off. A simulated
  kit gets no page at all. `start()` and `stop()` never raise and do no network I/O in `start()`. A failed bind, a broken
  manifest or a provider that cannot be built logs `video.disabled` with the failure class, and the core carries on.
  The service has no reference to the core: it receives a read-only snapshot callable and reports the robot's `state`,
  `banner`, `lockHeld`, `connected` and `simulated` fields.
- **`probe-video-isolation`.** A subcommand runs six checks with robot A's video identity: its own credentials, its own
  channel endpoint (the positive control), another robot's channel endpoint as master and as viewer, its own
  `DescribeSignalingChannel` (denied: the role has no `Describe*`), and another thing's credentials (check 6). Requests
  are signed with `awscrt.auth.aws_sign_request` and sent over HTTPS with `urllib`, redirects refused. Only two read-only
  operations are called. It needs no MQTT connection, so the agent may keep running. Check 6 counts as a denial only when
  the robot's own credentials fetch again and succeed right after the refusal; otherwise the result is `INCONCLUSIVE`,
  which fails the check. A `404` on the other channel is `INCONCLUSIVE` too, and an optional `--other-channel-arn` lets
  the operator name the real channel. The probe logs nothing and writes only fixed labels in `probe.result` lines.

## Alternatives considered

| Option                                                             | Pros                       | Cons                                                                                                                                             | Why not                                                                                                             |
| ------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Credentials through `ssl` with `load_cert_chain` and an HTTPS call | Standard library only      | `load_cert_chain` takes file paths, so the key would be written to a temporary file (T2, R31); the caller also has to sign the thing-name header | awscrt takes bytes, is already a dependency (awsiot), and is the AWS-maintained client for the credentials provider |
| Query string `?t=<token>`                                          | Simple to type             | The token reaches the request line, the browser history and any log                                                                              | A fragment is never sent by the browser                                                                             |
| Token in a cookie or in browser storage                            | The page survives a reload | Written to disk, and open to CSRF or to other pages of the origin                                                                                | Memory-only session key; a reload asks for `SIGUSR1`                                                                |
| `http.server.ThreadingHTTPServer` in a thread                      | Stdlib, familiar           | Reads the core's snapshot from another thread; the core is single-threaded asyncio                                                               | The service stays on the event loop                                                                                 |
| `aiohttp`                                                          | Mature parser and routing  | A new dependency and attack surface for five routes                                                                                              | A strict parser of about 150 lines, with exact-match routing, is smaller to audit                                   |
| Page failure halts the core                                        | One failure model          | A webcam or a browser could stop the robot                                                                                                       | The safety core must not depend on video; a side service failure is contained (ADR 0035)                            |
| Extend `probe-isolation` with the video checks                     | One command                | Different network path and prerequisites; the MQTT probe needs the agent stopped for the client identifier                                       | A separate subcommand, the same `probe.result` format                                                               |

## Consequences

- Easier: the robot keeps its telemetry and its stop whatever the page does. A reviewer reads every limit in
  `video/constants.py`, and every refusal has a test that names it.
- Harder: an operator who reloads the page must run `kill -USR1` on the agent. Two agents on one VM would each print
  their own address.
- Watch, security impact: the session key has no idle expiry, so anyone who holds it while the agent runs can read
  credentials until the next rearm or the agent's exit (R36). The token may reach a supervisor's journal when the agent
  is not run from an interactive terminal, so the runbook requires the terminal. Any local user can flood the loopback
  port or send five wrong claims, which locks the claim until `SIGUSR1` (R36). The CSP `connect-src` cannot name a
  single KVS channel host, because the signaling host is per channel; the wildcard is bounded by the region and by IAM
  (R36).
- Cost: the credentials provider makes one call per 40 minutes when healthy. The probe adds six requests per run.
  Expected cost is below 0.10 USD for the whole demo (`docs/COSTS.md`).
- Threats: T1 (the thing name bound in the provider and the probe), T2 and T9 (no key, token or credential in a log,
  an exception, a representation or a URL), T8 (the master role limited to the robot's own channel, probed), T20 (the
  service never reads or writes `simulated` except to show it), T22 (every loop capped, tasks cancelled on stop),
  T24 (loopback, Host, Origin and Fetch-Site checks, lock, rate limit, headers). See
  `docs/security/THREAT_MODEL.md`.
