# ADR 0039 — Telemetry consumer: SQS batching, partial batch failure and fan-out

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-4, FR-ROB-5, NFR-PERF-1, NFR-REL-2, NFR-COST-1, NFR-COST-2
- Threats: T11 (flood), T13 (lost events), T34 (fan-out amplification)
- Builds on ADR 0031 (telemetry goes to SQS through a rule) and ADR 0038 (state writes).

## Context

Telemetry is published at QoS 0 and reaches the console through an IoT rule into the standard SQS queue
`mfc-demo-telemetry` (ADR 0031). A telemetry message is worth little after a second, but a lost message is not an
error: the next one replaces it. The console needs a p95 under one second (NFR-PERF-1), and DynamoDB and API Gateway
costs scale with the number of invocations and of WebSocket messages, so the consumer must not run once per message.

## Decision

- **Consumer wiring.** A Lambda event source mapping on the telemetry queue, with batch size 100, a batching window
  of `telemetry_batch_window_seconds` (default 1, validated between 0 and 5), `ReportBatchItemFailures`, and a maximum
  concurrency of 5. The function timeout is 10 s and the queue visibility timeout is 60 s, at least six times the
  timeout (a Terraform test pins it). The queue redrives to its dead-letter queue after five receives. The function
  has no retry and no dead-letter queue of its own: a failed record is redelivered by SQS.
- **Partial batch failure.** Only records that could be processed later are returned as failures:
  - a record whose state write threw (after the SDK retries) returns with its robot's message identifiers, and the
    other robots of the batch succeed; its sample is still fanned out;
  - records not reached because less than 2 s of the timeout remain are returned unprocessed, and the fan-out is
    skipped.
    A record that is not JSON, or that fails classification (`TelemetryRejected{reason}`), is dropped and counted, not
    failed: a redelivery returns the same bytes, so a failure would only loop to the dead-letter queue.
- **Fan-out.** Once per site and invocation, one aggregated `fleet.delta` is built, split into frames of at most 70
  robots and 30 000 bytes (ADR 0043). Recipients come from the `bySite` index of the connections table (at most three
  pages, so 300 connections). Frames are pushed with a concurrency of 10. Expired sessions are closed, at most five per
  call. A gone connection is removed. A failed push is counted and never retried (`droppable`): the next sample
  replaces it. A fan-out error never fails the batch. A redelivered batch whose samples are already stored is dropped
  as `STALE` and is not fanned out again.
- **Consumer toggle.** `scripts/demo-consumer.sh enable|disable|status` changes the state of the mapping. Terraform
  declares `enabled` with `ignore_changes`, so a deploy does not turn the consumer back on. `make demo-stop` disables
  it (THREAT_MODEL R45).

## Alternatives considered

| Option                                | Pros                   | Cons                                                             | Why not                                                      |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Kinesis Data Streams                  | Ordered shards, replay | Shard cost, another service, ordering not needed (ADR 0038)      | No gain at demo scale                                        |
| FIFO queue                            | Per-group order        | Throughput limits and cost; order is restored by the state write | The state write already restores the order                   |
| One invocation per message            | No batching logic      | Several times more invocations, DynamoDB calls and fan-outs      | Cost (NFR-COST-1) and fan-out amplification (T34)            |
| Publish frames through IoT or AppSync | No own fan-out code    | More services and a second connection model                      | No benefit at demo scale (ADR 0041)                          |
| Window of 0 seconds                   | Lowest latency         | About twice the invocations and WebSocket messages               | Kept as the rerun option if the load check exceeds 1.2 s p95 |

## Consequences

- Latency adds up to the batching window (1 s by default) to the processing time. The live load check measures the
  p95 (`ws-probe`, not yet in the repository); above 1.2 s the window is set to 0 and the check is run again.
- Concurrency 5 bounds the DynamoDB writes and the fan-out of the consumer. Messages older than one hour expire in the
  queue, so a consumer left disabled loses telemetry, which is acceptable: telemetry is replaced by the next sample.
- Fan-out is best effort. A dropped frame is not visible to the console except as a gap, which the console detects
  with the `(bootId, seq)` order (client rule in `packages/protocol/src/ws.ts`).
- The telemetry consumer raises no alert (ADR 0040), so a telemetry problem never opens one.
- Cost: about 380 k invocations of 0.15 s over the M5 period, within the free tier (COSTS.md).
