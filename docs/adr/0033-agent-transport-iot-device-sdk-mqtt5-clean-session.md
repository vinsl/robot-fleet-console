# ADR 0033 — Agent transport: AWS IoT Device SDK v2, MQTT 5, clean sessions, broker presence instead of LWT

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-3, NFR-REL-1, NFR-REL-3, SEC-ID-1, T1, T12, T22

## Context

The robot agent holds one mutual-TLS connection to AWS IoT Core. It must reconnect by itself after a network cut,
and the cloud must learn when the robot goes away. SPEC §4.1 names the AWS IoT Device SDK v2. The robot policy
(ADR 0030) grants publish only on the three rule topics, and subscribe and receive only on the robot's own command
topic. It grants no persistent-session action. A command older than 2 s is refused by the robot (ADR 0027), so a
command queued while the robot was offline would be stale. The isolation probe has to see a refusal as an MQTT
reason code (0x87 or 135), so the transport must expose them.

## Decision

The agent uses `awsiotsdk==1.31.*` and builds an MQTT 5 client with `mtls_from_bytes`
(`agent/src/fleet_agent/adapters/mqtt_crt.py`):

- **Clean session**, no session expiry. Nothing is queued by the broker for a robot between connections. The
  transport resubscribes on every connection.
- **Reconnection by the CRT client itself**, with full jitter, from 1000 ms to 30000 ms. The delay resets after the
  link has stayed up for 30 s. No loop of our own wraps `start()` and `stop()`.
- **Keep alive 30 s**, and an inbound packet cap of 8192 bytes, sent as `maximum_packet_size` on CONNECT. The payload
  cap of 4096 bytes is enforced by the core (ADR 0034, step 1). SDK metrics collection is off.
- **No last will.** Presence comes from the broker's lifecycle events, which the presence rule of ADR 0031 already
  forwards.
- **QoS 0 for telemetry, QoS 1 for events, acknowledgements and the command subscription.** The offline queue fails
  QoS 0 publishes while disconnected instead of holding them.
- **Thread marshalling.** The CRT runs its own threads. Every callback copies its data and hands it to the event loop
  with `call_soon_threadsafe`, so the core is entered on the loop thread only. Each publish and each subscribe reports
  its outcome to `on_done` exactly once. A client stop settles every pending operation as `FAILED`
  (`ClientStoppedError`).
- **Restart after a suspend.** A restart scheduled before a shutdown does not start the client, and the check runs again
  when the timer fires.

Dependency facts, checked on 2026-11-02 against `agent/uv.lock`:

- `awsiotsdk` 1.31.0, Apache-2.0, uploaded 2026-07-24. Its only requirement is `awscrt==0.36.1`.
- `awscrt` 0.36.1, Apache-2.0, uploaded 2026-07-22. It ships `cp311-abi3` wheels for manylinux x86_64 and aarch64,
  which CPython 3.12 accepts. The lock pins every wheel and the sdist by SHA-256. Both releases are older than the
  14-day `exclude-newer` span.
- Neither package ships `py.typed`. `pyproject.toml` therefore sets `ignore_missing_imports` for `awscrt` and `awsiot`,
  and the transport puts the SDK behind a typed protocol (`Mqtt5ClientLike`). The core sees only its `Transport` port.

## Alternatives considered

| Option                                               | Pros                                                                 | Cons                                                                                                                                          | Why not                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `aiomqtt` or `paho-mqtt` 2.x                         | Pure Python, no compiled wheel to trust, asyncio wrapper (`aiomqtt`) | We would write the reconnection loop, the X.509 wiring and the offline behaviour, and P5 would need a second path to the credentials provider | SPEC §4.1 names the SDK. One CRT package serves the MQTT link now and the credentials provider in P5 (planned)        |
| Persistent session (session expiry, queued commands) | Commands sent while the robot is down are delivered on reconnection  | A queued command is stale (2 s window, ESTOP aside), and the robot policy grants no persistent-session action                                 | Clean session. Resubscribe on every connection, and an ESTOP never waits behind a queue (ADR 0034)                    |
| Last will on an events topic                         | The broker reports an ungraceful loss without the robot's help       | The policy grants no publish outside the three rule topics, so a will topic needs a new grant                                                 | Presence lifecycle events already report ungraceful disconnects, and AWS recommends them over a will for connectivity |

## Consequences

- Easier: no reconnection loop of our own, and the robot policy stays as reviewed. No IAM action and no Terraform
  change are needed. The 1 s minimum delay is meant to stay within the connect rate that the AWS IoT Core quotas page
  documents for one client identifier (one CONNECT per second, as cited in the M4 design).
- Harder: the transport depends on a compiled package. Each upgrade is a deliberate change of the pinned wheel hashes.
  The CRT TLS context refuses a bad key with a `RuntimeError`, not an `AwsCrtError`. The kit loader maps every error the
  SDK can raise for a key to one code (ADR 0035, JOURNAL 2026-11-02).
- Watch: the marshalling rule. Any new callback that touches the core off the loop thread breaks the single-threaded
  core. The tests `test_a_callback_from_another_thread_reaches_the_listener_on_the_loop_thread` and
  `test_publish_reports_its_completion_once` in `agent/tests/adapters/test_mqtt_crt.py` pin it.
- Security: the robot accepts no inbound connection. Its only inbound traffic is its own command topic, and the packet
  cap bounds the memory of each message (T22). Presence is decided by the broker, so a robot cannot claim it is online
  or offline. A graceful stop is still announced by `GOING_OFFLINE` (ADR 0034).
- Cost: no AWS resource is added. The message and connection volume is at demo scale, as estimated in the design, and
  not measured.
- Accepted: a robot that drops without a clean disconnect is reported as disconnected by the broker only after its
  keep-alive lapses (30 s).
- Threats: T1 (own client identifier and topics), T12 (link loss, with the deadman running offline), T22 (reconnection
  and memory bounds). See `docs/security/THREAT_MODEL.md`.
