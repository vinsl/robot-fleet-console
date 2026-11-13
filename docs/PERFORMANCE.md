# Performance measurements

What was measured on the deployed demo on 6 Nov 2026, how, and what the numbers do not show. Targets come from
`docs/SPEC.md` (NFR-PERF-1). Nothing here is a guarantee: the samples are small and taken on one session.

## Command round trip

- Target: p95 below 500 ms.
- Method: the Operator sends commands from the robot panel of the console. The console shows, for each command, the time
  from the click to the acknowledgement of the robot (the "Command log", `docs/screenshots/16-command-ack-latency.png`).
  The values were read from that log by hand.
- Sample: 31 acknowledged commands (take control, release control, pause, resume, return to base). One `Resume` was
  refused with "invalid state": the state machine rejects it, so it is not a latency and is left out.

| Statistic | Value  |
| --------- | ------ |
| Minimum   | 207 ms |
| Median    | 295 ms |
| Mean      | 319 ms |
| p90       | 393 ms |
| p95       | 470 ms |
| Maximum   | 877 ms |

- Two of the 31 commands were above 500 ms (542 ms and 877 ms). With 31 samples the p95 rests on the two largest values,
  so "470 ms" says the target is met on this sample, not that it holds in general.
- Not recorded: the network of the operator, and whether each command was sent to a simulated robot or to the real agent.

## Video latency

- Target: below 500 ms (NFR-PERF-1).
- Method: the transport latency shown by the video overlay of the robot panel (WebRTC statistics), read 11 times.
- Values (ms): 16, 29, 42, 42, 45, 45, 46, 48, 49, 53, 75. Median 45 ms, p95 about 64 ms, maximum 75 ms.
- Limit: this is the transport round trip, not the delay between a movement and its image. The webcam of the VM delivers
  1 to 3 frames per second (`docs/adr/0025-video-spike-hand-made-channel-and-session.md`), which is too low to film a
  clock and measure the end-to-end delay.

## Load check with 20 simulated robots

- Method: 20 simulated robots started together.
- Result: the first ten robots ran and the other ten stayed offline. After about two minutes all twenty were shown
  offline, and the console returned "The request failed. Try again in a moment".
- CloudWatch: the alarm `mfc-demo-ingest-events-throttles` went to the alarm state (10:22 UTC and again at 10:46 UTC).
  Its rule is "Throttles greater than 0 within five minutes" on the Lambda function `mfc-demo-ingest-events`.
- Cause found: the concurrent executions limit of the account is 10 and it is shared by every Lambda function.
  `mfc-demo-ingest-events` is invoked by the IoT rules for events, acknowledgements and presence, with no queue in front
  of it, so a burst of robots goes past the limit and the invocations are throttled.
- Most probable link with the offline robots (not verified in the logs): presence events were throttled, so the console
  marked the robots offline.
- The telemetry path is protected differently: its queue consumer is capped at 5 concurrent invocations
  (`infra/envs/demo/ingest.tf`), so telemetry does not use the whole quota.
- The test was not repeated. Planned fixes: ask AWS for a higher Lambda concurrency quota (Service Quotas, no cost) and
  put a queue in front of `ingest-events`, as for the telemetry. The load check is therefore not passed: the demo is
  validated with at most ten simulated robots.

## Estimated and not measured

- Cost: about 65 USD per month for 20 robots 12 h per day is an estimate (`docs/report/cost-estimate.md`). Only the
  development period has a measured cost (`docs/COSTS.md`).
- Not measured: telemetry to screen (target p95 below 1 s), the delay of the deadman, cold start durations, the load time
  of the console on a mobile network, and the percentage of test coverage (the gate is 80 %).
