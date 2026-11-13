# Costs

Target: **0 € out of pocket** over the project (free tier + account credits). Budgets: gross usage alerts
at 3 € and 5 €, plus an alert on any net charge. One line per day from Cost Explorer (group by service,
tag `component`).

## Daily log

Source: Cost Explorer, `get-cost-and-usage`, daily, grouped by service, `UnblendedCost` (gross, before credits), read on
2026-11-04 for 2026-10-30 to 2026-11-04. Cost Explorer reports in USD, so this table is in USD. Cost Explorer lags by about
a day: the last two lines are incomplete, and the live demo of 3 and 4 November is not fully counted yet. Net charged is not
read here: the credits are applied to the invoice, not to these lines. Refresh the last lines before the report is sent.

| Date       | Gross usage (USD) | Top 3 services                               | Notes                                                    |
| ---------- | ----------------- | -------------------------------------------- | -------------------------------------------------------- |
| 2026-10-30 | 0.00              | none (AWS Glue and S3 at 0)                  | Account hardened, budgets created                        |
| 2026-10-31 | 0.00              | none (AWS Glue, SNS and S3 at 0)             | Terraform foundation                                     |
| 2026-11-01 | 0.05              | KVS 0.047, S3 0.004                          | Video spike. Plus 0.03 tax, not counted in the 0.05      |
| 2026-11-02 | 0.10              | KVS 0.094, S3 0.005, IoT 0.002               | Robot agent, ingest and simulators. DynamoDB below 0.001 |
| 2026-11-03 | 0.01              | S3 0.008, API Gateway 0.001, DynamoDB 0.0003 | Console and API. Day incomplete (data lag)               |
| 2026-11-04 | 0.001             | S3 0.0006                                    | Day incomplete (data lag): to refresh                    |
| **Total**  | **0.16**          |                                              | Plus 0.03 tax. Before credits                            |

Reading: the measured gross usage is about 0.16 USD over the first six days, far below the estimates of the sections below
(about 3.5 to 4.5 USD for the robot and realtime stacks). The estimates assumed simulators running for hours; the measured
days include only short runs. The lag also hides the recent days, so the measured total is a lower bound until the lines
of 3 and 4 November are refreshed. The 3 € gross alert is not reached.

Budgets (ADR 0023): the account has three budgets. Whether AWS Budgets bills them is not checked yet. Record the line
item here once it is.

## Robot identity and ingest (M4 P3): estimate

Estimate for the demo scale of 10 simulated robots and 1 real robot, about 70 hours of simulator time, with AWS prices
from the IoT Core pricing page (Ireland and Canada examples). This is an estimate, not a measurement: check it in Cost
Explorer after the first full day with the robot stack, and add the line to the daily log.

| Item                                                          | Volume                 | Estimate (USD)                                                        |
| ------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Basic Ingest telemetry                                        | ~1.8 M messages        | 0 (no messaging charge; rules are billed)                             |
| Rule triggers and actions (telemetry, events, acks, presence) | ~2.0 M                 | ~0.60                                                                 |
| SQS requests (sends, and the receives of M5)                  | ~2.5 M                 | ~0.60 after the 1 M free tier                                         |
| ingest-events Lambda                                          | ~0.3 M invocations     | free tier                                                             |
| X-Ray on ingest-events (default sampling)                     | ~0.3 M requests        | up to 0.50 beyond the 100 k free traces                               |
| CloudWatch Logs (seven-day retention)                         | ~150 MB                | ~0.10                                                                 |
| KVS, one active channel-month for the real robot              | 1 channel-month        | ~0.03                                                                 |
| IoT connectivity, registry and audit writes, robots function  | tens of calls          | below 0.01                                                            |
| Idle, simulators off                                          | none (no consumer yet) | ~0                                                                    |
| Three queue alarms (telemetry DLQ, ingest DLQ, rule errors)   | 3 alarms, standard     | ~0.30 per month, about 0.01 per day (check the CloudWatch price page) |
| **Added by M4 P3**                                            |                        | **about 1.5 to 2 over the period, plus about 0.01 per day**           |

The telemetry queue keeps messages for one hour and redrives to its dead-letter queue after five receives (T22), so an
idle queue costs nothing beyond the requests that fill it. The three queue alarms are the only fixed fee of the robot
stack (standard alarms, about 0.10 USD each per month); they publish to the existing alarm topic at no extra cost.

Cost basis of the robot stack, checked against the Terraform tests of M4 P3:

- Rule triggers: each message on `fleet/+/+/events` and `fleet/+/+/cmd/ack` is one rule action and one `ingest-events`
  invocation. Presence is one rule action per lifecycle event of a demo client (the rule filters on the `mfc-demo-`
  client id prefix). The rule row of the table above covers these three streams.
- Log retention: the `lambda-function` module keeps function logs for seven days by default (`log_retention_days`), so
  the `robots` and `ingest-events` log groups keep seven days; the `robots` group is asserted in
  `lambda_function.tftest.hcl`. The IoT logs group `AWSIotLogsV2` keeps seven days (`robot_iot.tftest.hcl`). The CloudWatch
  Logs row above assumes these values.
- Embedded metric format: `ingest-events` publishes one EMF line per invocation, which CloudWatch Logs ingests as a log
  line. It must not be used for telemetry: per-robot telemetry at that rate would be billed as log ingestion for every
  message. Telemetry belongs to the M5 consumer of the telemetry queue.

## Realtime and ingest (M5): estimate

Estimate for the M5 demo scale: 10 simulated robots and 1 real robot, about 70 hours of simulator time, and viewers
connected for about 15 hours in total with two connections on average. Prices are the AWS list prices to re-check on
the pricing pages (eu-west-3). This is an estimate, not a measurement: replace it with the Cost Explorer figures after
the first full day of the M5 stack, and add the daily line to the log above.

| Item                                                           | Volume                                      | Estimate (USD)                                                    |
| -------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| SQS receives and deletes of the telemetry queue                | about 0.3 M requests                        | about 0.1 (inside the 1 M free tier shared with the sends of M4)  |
| `ingest-telemetry` Lambda                                      | about 380 k invocations, 0.15 s, 256 MB ARM | free tier                                                         |
| `ingest-events` extra duration (DynamoDB calls)                | about 0.3 M invocations, 80 ms more each    | free tier                                                         |
| DynamoDB writes (state, history, alerts, frame counters)       | about 0.75 M write units                    | about 1.0 at about 1.3 to 1.5 USD per million                     |
| DynamoDB reads (connection queries, claims, snapshots)         | about 0.5 M                                 | about 0.15 at about 0.27 USD per million                          |
| API Gateway WebSocket messages and connection minutes          | about 0.16 M messages                       | about 0.2                                                         |
| `ws-*` Lambda functions                                        | tens of thousands                           | free tier                                                         |
| X-Ray traces (default sampling)                                | up to about 0.26 M, 0.1 M free              | about 0.8 in total, which replaces the 0.5 of M4 (adds about 0.3) |
| CloudWatch Logs and embedded metrics (about 12 custom metrics) | small                                       | about 0.3                                                         |
| Load check itself                                              | one 10-minute run                           | about 0.05                                                        |
| **Added by M5**                                                |                                             | **about 2.0 to 2.5 over the period**                              |

Notes:

- With the M4 P3 lines, the total is about 3.5 to 4.5 USD gross. The 3 EUR gross budget alert will probably fire, and
  the 5 EUR one only if the simulator runs far beyond 70 hours. Net charge stays at 0 with the account credits.
- Levers, in order: fewer simulator hours (the cost scales with them), `make demo-stop` after every session (it stops the
  polling and the fan-out), X-Ray sampling left at the default, and `telemetry_batch_window_seconds` left at 1 (a window
  of 0 roughly doubles the invocations and the WebSocket messages, about +0.3).
- Idle cost with the consumer disabled and no simulator: 0. No alarm was added in M5.

### Alarms (M10)

Standard CloudWatch alarms cost about 0.10 USD each per month, with the first 10 alarm metrics of the account free.
The stack has 32 alarms once M10 is applied, so about 3.20 USD per month before the free tier and about 2.20 USD
after it. The alarms are created by the stack and are not removed by `make demo-stop`.

- Errors and Throttles of the 12 Lambda functions (lambda-function): 24 alarms, about 2.40 USD before the free tier.
- ParseError of the 4 IoT rules (iot-rules): 4 alarms, about 0.40 USD before the free tier.
- Dead-letter and rule error queues (queues): 3 alarms, about 0.30 USD before the free tier.
- API 5xx (http-api): 1 alarm, about 0.10 USD before the free tier.

## Control, safety and robot page (M9): estimate

Estimate for the M9 demo scale, from the design (section 10). One operator session sends about 50 commands. One 5-minute
control with heartbeats at 4 per second makes 1 200 WebSocket frames, 1 200 `ws-message` invocations, 1 200 lock reads
and 1 200 IoT Core publishes (the lock is written at most every 10 s, so about 30 writes). Three viewers add the 15 s
demo poll and the 60 s registry poll, under 2 000 HTTP calls in a 2-hour demo day. The `ws-message` function at 4 Hz
runs 40 ms per call, so 1 200 calls use about 48 s at 256 MB.

Total: under 0.01 USD per day, with no new fixed cost. M9 adds no table, no queue and no Cognito add-on. The video uses
Cognito Identity inside its free tier. IoT Core is charged per million messages at list price, to re-check on the pricing
page.

This is an estimate, not a measurement. Add the M9 days to the daily log above from Cost Explorer once a day with
control traffic is visible, and replace the estimate with the figures.

## Design choices that keep the cost near zero

| Choice                                                                        | Avoided cost                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Serverless only (Lambda, API Gateway, DynamoDB on-demand, IoT Core, KVS)      | No idle EC2/containers                                                                 |
| No VPC for Lambdas                                                            | NAT Gateway (~35 €/month)                                                              |
| CloudFront + private S3 for the console                                       | No ALB, no web server                                                                  |
| IoT Basic Ingest (`$aws/rules/...`)                                           | Broker messaging charge for telemetry                                                  |
| SQS batching (1 s window) between IoT and the ingest Lambda                   | One Lambda invocation and one WebSocket message per batch instead of per robot message |
| Positions go to the WebSocket, DynamoDB written on state change or every 10 s | ~90 % fewer write units                                                                |
| Simulated robots at 0.5 Hz while moving, console interpolates                 | Half the messages, same visual result                                                  |
| Simulators run on the owner's PC, auto-stop after 2 h, `make demo-stop`       | No permanent compute, no runaway                                                       |
| AWS-owned encryption keys, no WAF, no custom domain                           | Fixed monthly fees                                                                     |
| Log retention 7 days, X-Ray sampling                                          | Storage and trace fees                                                                 |
| GuardDuty / Security Hub only during the 30-day trial                         | Monthly fees after the trial                                                           |

## Estimate at demo scale (to check against the AWS pricing pages on day 1)

Assumptions: 10 simulated robots at 0.5 Hz + 1 real robot at 2 Hz ≈ 7 messages/s while the simulator
runs; 2 consoles open; simulators running ~10 h/day for 7 days (70 h).

| Item                                       | Volume over 70 h     | Order of magnitude                |
| ------------------------------------------ | -------------------- | --------------------------------- |
| IoT Core messages                          | ~1.8 M               | ~2 €                              |
| SQS requests                               | ~2–3 M               | < 1 € (first 1 M free each month) |
| Lambda invocations (batched)               | ~0.3 M               | free tier                         |
| API Gateway WebSocket messages             | ~0.5 M               | < 1 €                             |
| DynamoDB on-demand writes                  | ~0.3 M               | < 0.5 €                           |
| KVS signaling + TURN                       | a few hours of video | < 0.5 €                           |
| CloudFront, S3, Cognito, CloudWatch, X-Ray | demo traffic         | free tier                         |
| **Total gross**                            |                      | **~3–5 €, covered by credits**    |

Audit trail (ADR 0022): about 0.15 USD per month. This is an estimate, not a measurement: check it in Cost Explorer
after the first full month.

Idle cost when the simulator is stopped: SQS long polling by the Lambda event source mapping
(~0.65 M requests/month, within the SQS free tier) — `make demo-stop` disables the mapping anyway.
