# ADR 0031 — IoT rule deliveries: broker metadata plus base64 payload, one events function

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-3, SEC-ID-1, NFR-REL-2, NFR-OBS-1, T1, T5, T13, T22

## Context

Robots publish on four kinds of topic: telemetry, events, command acknowledgements and the broker's own presence
events. The cloud must trust the identity of a message only from the broker, because the robot writes the payload.
A rule that fails on a payload it cannot read stops that delivery without a trace, and a payload that is too big or
not JSON must be refused and counted, never retried. Telemetry is high volume and only a queue is needed for it in
M4; events, acks and presence need the validation of the robot protocol (ADR 0027), which lives in TypeScript.

## Decision

- **Four rules, each with an error action.** `mfc_demo_telemetry` sends to the SQS queue `mfc-demo-telemetry`.
  `mfc_demo_events`, `mfc_demo_acks` and `mfc_demo_presence` invoke the function `mfc-demo-ingest-events`. Every rule
  sends its failed deliveries to the SQS queue `mfc-demo-iot-rule-errors`, kept four days.
- **Same envelope in every robot rule.** The robot rules select
  `'robot' AS source, topic() AS iotTopic, clientid() AS iotClientId, timestamp() AS iotReceivedAt,
encode(*, 'base64') AS payloadBase64`. The broker metadata cannot collide with a payload key, and the payload is
  passed as bytes: a payload that is not JSON or is too large is classified by the function as a counted rejection,
  and the rule itself never fails on the content.
- **Presence.** The rule selects `$aws/events/presence/+/+` and keeps only the clients whose id starts with
  `mfc-demo-`. The function reads the thing name of the client. The rule selects an explicit field list, the fields of
  `PresenceEventSchema` (amendment of 2026-11-02, review of the P3 slices): the IP address, the principal identifier and
  the session identifier never leave the broker, so they never reach the error queue or the ingest dead-letter queue.
- **Identity anchor is the broker.** The function parses `iotTopic` (the topic is enforced by the IoT policy, ADR 0030) and requires that the ids in the payload equal the ids of the topic, and that `iotClientId` equals the thing
  name of the topic robot. Any mismatch is rejected and counted (`IDENTITY_MISMATCH`, `CLIENT_MISMATCH`), logged at WARN
  without the payload, and not retried.
- **Queues and retries.** The telemetry queue keeps messages for one hour, with a visibility timeout of 60 s, long
  polling of 20 s, and a redrive to `mfc-demo-telemetry-dlq` after five receives. The ingest function is asynchronous:
  two retries, a maximum event age of 300 s, and a dead-letter queue `mfc-demo-ingest-events-dlq`. In P3 it has no
  side effect, so a retry is harmless; M5 makes its writes idempotent on `(bootId, seq)` and `commandId`.

## Alternatives considered

| Option                                             | Pros                                | Cons                                                                               | Why not                                         |
| -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `SELECT *, clientid() AS ...`                      | Payload fields readable in the rule | A payload key can collide with a metadata alias; a non-JSON payload fails the rule | The rule must not depend on the payload content |
| CloudWatch Logs as error action                    | No queue                            | Not alarmable by depth, which M10 needs                                            | SQS depth is the alarm of T13                   |
| Lambda destinations instead of a dead-letter queue | Results routed by outcome           | More configuration to test, and a second mechanism for the same failure            | One mechanism, the queue, for every failure     |
| One function per rule                              | Smaller functions                   | Four roles and permissions to test for the same classification                     | One classification, one role, one set of tests  |
| JSON payload instead of base64                     | Payload readable in the rule        | Non-JSON or oversize content fails inside the rule                                 | The function must classify every delivery       |

## Consequences

- The events function receives the payload as base64, about a third larger on the wire. The decoded payload is capped at
  4096 bytes, so the cost is negligible at demo volume.
- Every robot message is billed as a rule trigger and an SQS request (T22). The telemetry consumer that drains the queue
  arrives in M5, and until then the queue fills for at most one hour, then expires.
- The function never logs a payload, refused or accepted, nor the connection address of a presence notice. Its logs carry
  the ids, the reason of a refusal and the schema paths only.
- The rule names, the SQL strings and the queue names are pinned by the Terraform tests (`iot_rules`, `queues`).
