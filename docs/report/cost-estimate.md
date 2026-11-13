# Monthly cost estimate: 20 robots, 12 h/day, 30 days (eu-west-3, USD, list prices)

Estimate, not a measurement. Recomputed 2026-11-04 from the code and the AWS Price List files for EU (Paris)
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/eu-west-3/index.json`, offers `AWSIoT`,
`AWSQueueService`, `AWSLambda`, `AmazonDynamoDB`, `AmazonApiGateway`, `AmazonKinesisVideo`, `AmazonCloudWatch`,
`AWSXRay`, `AmazonCognito`). The marketing pricing pages give no Paris price; the Paris figures differ from the earlier
draft (IoT rules 0.18 not 0.15, KVS TURN 0.19 not 0.12). Free tier is shown separately.

## Hypotheses, each checked
- Active time 360 h = 1.296 M s. Telemetry 1 Hz average x 20 robots = 25.92 M messages, Basic Ingest topic
  `$aws/rules/telemetry/...` (no messaging charge), rule `FROM 'fleet/+/+/telemetry'` with one SQS action
  (`infra/modules/iot-rules/main.tf`): 2 rule units per message (trigger + action).
- Events, acks, presence: events and acks also use Basic Ingest, so only rule units apply; 0.45 M events/month
  (assumed 1 state change/min/robot) go rule -> `ingest-events` Lambda (`iot-rules/main.tf`, SPEC section 5). Heartbeats
  are sent only after 5 s of silence (`agent/src/fleet_agent/core/scheduler.py`), so none while telemetry flows.
- Consumer: SQS batch 100, window 1 s, concurrency 5, 256 MB, arm64, 10 s timeout, Active X-Ray
  (`infra/envs/demo/ingest.tf`, `infra/modules/lambda-function/main.tf`, ADR 0039). Invocations: calibrated on ADR 0039 and
  COSTS M5 (7 msg/s gives 1.5 inv/s); model 1.0 + 0.05 x msg/s, so 2.0/s at 20 msg/s = 2.59 M, 0.15 s each. Each does
  1 receive + 1 delete; 0.33 M idle long polls (COSTS).
- HEARTBEAT: 1 h/day teleop = 30 h x 3600 x 4 = 432 k frames, each a `ws-message` invocation (40 ms), a strongly
  consistent lock read and one IoT publish billed as 2 messages (publish + delivery) (ADR 0063).
- DynamoDB on-demand (`modules/data-tables`): state write every 10 s per robot while moving (`LIVE_STATE_PERSIST_INTERVAL_MS`
  = 10 s) = 2.59 M, plus 0.43 M on change, plus per event state + history + GSI = 1.29 M; connections ~0, lock 11 k.
- WebSocket: `ingest-telemetry` pushes one aggregated `fleet.delta` per connection per invocation (ADR 0039):
  3 consoles x 2.59 M = 7.78 M, plus 0.44 M inbound (heartbeats, 5-min pings). Consoles also poll HTTP (15 s + 60 s):
  0.35 M requests.
- KVS: one channel per robot, 20 channels (worst case; only the real robot streams). 2 h/day = 3 600 min via TURN, billed on
  both peers = 7 200 TURN minutes, 360 sessions x 100 signaling messages.
- CloudWatch: 37 standard alarms counted in `infra/` (14 functions x 2, 4 rule ParseError, 3 queues, 1 API 5xx, 1
  HeartbeatPublishFailed); 3.84 M invocations x 1.2 KB of logs (platform lines + one EMF line), 7-day retention
  (`lambda-function/variables.tf`), IoT log level ERROR; about 30 custom metric series (Powertools EMF, namespace `mfc-demo`).
- X-Ray: Active on all functions, default sampling 1 trace/s + 5 percent, not configurable for Lambda: about 1.42 M traces.
  Cognito: Essentials tier (`modules/identity`), under 10 MAU.

## Cost table
| Item | Monthly volume | Unit price (EU Paris) and source offer | USD/month |
|---|---|---|---|
| IoT rules (trigger + action) | 52.74 M units | 0.18 per M, `AWSIoT` | 9.49 |
| IoT messaging (commands) + connection | 0.87 M msg; 432 k min | 1.20 per M msg; 0.096 per M min, `AWSIoT` | 1.09 |
| SQS requests | 31.43 M (25.92 M sends) | 0.40 per M, `AWSQueueService` | 12.57 |
| Lambda arm64 | 3.84 M inv; 117 k GB-s | 0.20 per M; 0.0000133334 per GB-s, `AWSLambda` | 2.33 |
| DynamoDB | 4.31 M WRU; 2.88 M RRU; < 1 GB | 0.7423 per M WRU; 0.1487 per M RRU; PITR 0.238/GB, `AmazonDynamoDB` | 3.70 |
| API Gateway WebSocket | 8.22 M msg; 65 k min | 1.19 per M; 0.297 per M min, `AmazonApiGateway` | 9.80 |
| API Gateway HTTP | 0.35 M req | 1.17 per M, `AmazonApiGateway` | 0.41 |
| KVS WebRTC | 20 channels; 7 200 TURN min; 36 k msg | 0.047; 0.19 per 1 000 min; 3.50 per M, `AmazonKinesisVideo` | 2.44 |
| CloudWatch Logs | 4.6 GB ingested | 0.5985 per GB, `AmazonCloudWatch` | 2.89 |
| CloudWatch alarms | 37 | 0.10 each, `AmazonCloudWatch` | 3.70 |
| CloudWatch custom metrics | about 30 series | 0.30 each, `AmazonCloudWatch` | 9.00 |
| X-Ray traces stored | 1.42 M | 5.00 per M, `AWSXRay` | 7.12 |
| S3, CloudTrail audit, Cognito, CloudFront | measured/negligible | COSTS.md (S3 0.008/day, audit 0.15), Cognito 0.015/MAU | 0.50 |
| **Total** | | | **65.04** |

- **Per robot: 3.25 USD/month** (about 0.11 per robot per day).
- Free tier (always-free only, not the 12-month IoT one): Lambda -1.76, SQS -0.40, X-Ray -0.50, Logs 5 GB -2.76, 10 alarms
  -1.00, 10 metrics -3.00 = about -9.4, so about **55.6** actually billed before credits.
- **Idle cost** (robots off, consumer disabled): the 37 alarms 3.70 + S3/CloudTrail/PITR/log storage about 0.6 = **about 4.3**
  (3.3 after the alarm free tier), not 0: the alarms are the fixed fee (`docs/COSTS.md`, M10).

## Sensitivities (same model, invocations follow 1.0 + 0.05 x msg/s)
- Telemetry 0.5 Hz (10 msg/s): 51.2 USD (-13.8), 2.56 per robot. SQS sends, rule units and 1.5 inv/s fall.
- Robot batches 5 samples per MQTT message (4 msg/s, 1.2 inv/s): 42.9 USD (-22.1), 2.15 per robot. It needs a protocol
  change and adds up to 5 s of age, which breaks NFR-PERF-1 (p95 < 1 s): a lever, not a recommendation.

## Largest items
SQS 19.3 %, WebSocket fan-out 15.1 %, IoT rules 14.6 %, custom metrics 13.8 %, X-Ray 10.9 %. The telemetry path
(rules + SQS + WebSocket + consumer Lambda) is about 49 %; observability (metrics, X-Ray, alarms, logs) about 35 %.

## Excluded
GuardDuty, Security Hub, AWS Config, support plan, tax, AWS Budgets, data transfer out (a few GB at most), domain, the
PCs and VMs running the robots and simulators, KMS (AWS-owned keys). Not modelled: idle simulated robots send a 5 s heartbeat through the
events rule and `ingest-events` (+ about 4 USD if 30 % of robot time is idle); invocation counts and the metric count are
the two least certain inputs (X-Ray up to 2.3 M traces if the reservoir is per function: +4 USD; metrics 20 to 45: 6 to 13.5).
Check against Cost Explorer (`CW:MetricMonitorUsage`, `XRay-TracesStored`, `Requests-Tier1`) before printing.
