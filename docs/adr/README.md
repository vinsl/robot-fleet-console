# Architecture decision records

One ADR per structural choice. They become the "Technical choices and alternatives" section of the report.
Expected ADRs (write each one in the PR that implements it; renumber freely):

| #    | Title                                                                                                          | Milestone | Status   |
| ---- | -------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| 0001 | pnpm monorepo with shared protocol package                                                                     | M1        | accepted |
| 0002 | CI security gate before any feature (tools and thresholds)                                                     | M1        | accepted |
| 0003 | Repository protection on a private repo (GitHub Pro vs Free fallback)                                          | M1        | accepted |
| 0004 | Console visual design: "Plan" layout, state language, "Graphite" style                                         | M0        | accepted |
| 0005 | Terraform with S3 native locking and a separate bootstrap                                                      | M2        | accepted |
| 0006 | Region eu-west-3 and Kinesis Video WebRTC availability                                                         | M2        | accepted |
| 0007 | Lambda runtime: Node.js 24 on ARM64 with esbuild and Powertools                                                | M2        | accepted |
| 0008 | Serverless without VPC (no NAT Gateway)                                                                        | M2        | accepted |
| 0009 | Kinesis Video WebRTC with a browser master on the robot                                                        | M3        | —        |
| 0010 | AWS IoT Core with per-robot X.509 and app-created certificates                                                 | M4        | —        |
| 0011 | IoT credentials provider for robot video access                                                                | M4        | —        |
| 0012 | SQS batching between IoT and Lambda, aggregated WebSocket fan-out                                              | M5        | —        |
| 0013 | DynamoDB: four tables over single-table design                                                                 | M5        | —        |
| 0014 | Cognito user pool + identity pool, tokens in memory                                                            | M6        | —        |
| 0015 | Front-end stack: React 19, Vite, React Router, TanStack Query, Zustand, Tailwind + shadcn/ui                   | M6        | —        |
| 0016 | i18n with react-i18next (en/fr)                                                                                | M6        | —        |
| 0017 | DXF parsed in a Web Worker with a bounded parser                                                               | M7        | accepted |
| 0018 | Control lock, deadman over WebSocket, e-stop priority                                                          | M9        | —        |
| 0019 | No WAF and AWS-owned keys (cost trade-offs)                                                                    | M10       | —        |
| 0020 | GitHub OIDC roles and deploy permission boundary                                                               | M2        | accepted |
| 0021 | Demo stack layout: one root, modules, default tags and the mfc-demo- prefix                                    | M2        | accepted |
| 0022 | Multi-Region management-events audit trail                                                                     | M2        | accepted |
| 0023 | Alarm e-mail channel and budgets as code                                                                       | M2        | accepted |
| 0024 | Trail bucket read-only to CI, and account-level S3 Block Public Access                                         | M2        | accepted |
| 0025 | Video spike: hand-made signaling channel and the SSO session pasted into local pages                           | M3        | accepted |
| 0026 | Vendored KVS WebRTC browser bundle, and AWS SDK v3 through the lockfile                                        | M3        | accepted |
| 0027 | Robot protocol v1: envelopes, commands, acks and replay rules                                                  | M4        | accepted |
| 0028 | Robot-side safety: state machine, lock, deadman and e-stop latch                                               | M4        | accepted |
| 0029 | Robot provisioning: IAM-invoked function, state-based idempotency, kit never stored                            | M4        | accepted |
| 0030 | IoT policy bound to the thing name and to provisioner-set thing attributes                                     | M4        | accepted |
| 0031 | IoT rule deliveries: broker metadata plus base64 payload, one events function                                  | M4        | accepted |
| 0032 | Lambda packaging, the lambda-function module and IAM policies as locals                                        | M4        | accepted |
| 0033 | Agent transport: AWS IoT Device SDK v2, MQTT 5, clean sessions, broker presence instead of LWT                 | M4        | accepted |
| 0034 | Agent core: ports and adapters, synchronous pipeline, lock, deadman and e-stop latch                           | M4        | accepted |
| 0035 | Agent configuration: kit read in place, file mode checks, TOML and environment settings                        | M4        | accepted |
| 0036 | Agent local video service: loopback page, fragment claim token, awscrt x509 credentials, video isolation probe | M4        | accepted |
| 0037 | Robot video page: spike promoted to `apps/robot-video`, committed build with manifest, visuals deviation       | M4        | accepted |
| 0038 | Live robot state in the fleet table, ordered by (bootId, seq), with a persist policy                           | M5        | accepted |
| 0039 | Telemetry consumer: SQS batching, partial batch failure and fan-out                                            | M5        | accepted |
| 0040 | Ingest events: alerts, presence and command acknowledgement relay                                              | M5        | accepted |
| 0041 | WebSocket API: single-use tokens, connect checks and connection limits                                         | M5        | accepted |
| 0042 | Simulator: wrapped agent core, grid A*, run model                                                              | M5        | accepted |
| 0043 | Real-time protocol schemas live in `packages/protocol`                                                         | M5        | accepted |
| 0044 | Cognito pool: admin-only accounts, TOTP MFA for every role                                                     | M6        | accepted |
| 0045 | Console auth client: SRP through the Cognito SDK, tokens in memory only                                        | M6        | accepted |
| 0046 | Web delivery: private bucket behind CloudFront, default certificate and strict CSP                             | M6        | accepted |
| 0047 | HTTP API: JWT authorizer, three routes, per-route throttles and exact CORS origins                             | M6        | accepted |
| 0049 | TOTP enrolment QR code: drawn offline with `qrcode`, as React SVG                                              | M6        | accepted |
| 0050 | Console test stack: Vitest with jsdom and Testing Library; Playwright deferred to M10                          | M6        | accepted |
| 0051 | End-to-end fake authentication seam: build flag, mode guard and dist scan                                      | M6        | accepted |
| 0052 | Styling: CSS modules over design tokens, and a build check for the strict CSP                                  | M6        | accepted |
| 0048 | Runtime console configuration: `config.json` written by the publish script from the stack outputs              | M6        | accepted |
| 0053 | Site maps: presigned POST uploads and pinned S3 object versions                                                | M7        | accepted |
| 0054 | Site configuration: pure wizard reducer, derived draft, three-request save and two-step activation             | M7        | accepted |
| 0055 | Sample DXF: a generated original drawing instead of a downloaded one (deviation from SPEC §4.5)                | M7        | accepted |
| 0056 | Workstation footprint as an optional size on the point, with the point as mission target                       | M7        | accepted |
| 0057 | Console live fleet state: one reducer, protocol ordering, silence and reconnect rules                          | M8        | accepted |
| 0058 | Fleet map: projected upright markers, 2D pan and zoom inside the tilted plane, interpolated motion             | M8        | accepted |
| 0059 | KPIs computed in the console in M8, with session windows where the history is missing                          | M8        | accepted |
| 0060 | Alert sound with Web Audio tones, autoplay unlock and a local mute                                             | M8        | accepted |
| 0061 | Alerts API: site-scoped routes, key locator, strict lifecycle and transactional audit                          | M8        | accepted |
| 0062 | Control plane: one control function, cloud-held lock token, command claims and policy table                    | M9        | accepted |
| 0063 | Console heartbeat over the WebSocket, server-side deadman check and the hidden tab                             | M9        | accepted |
| 0064 | Audit trail for commands, lock and demo mode, read through the status index                                    | M9        | accepted |
| 0065 | Demo mode flag and three layers for simulated faults                                                           | M9        | accepted |
| 0066 | Robot panel: command and lock stores, one-click e-stop, confirmed release                                      | M9        | accepted |
| 0067 | Console video viewer: vendored KVS bundle and identity pool credentials                                        | M9        | accepted |
| 0068 | Simulator workstation reservation: a station is held by one robot, WORKING only on a held station              | M9        | accepted |
| 0069 | Deployed-URL e2e with an ephemeral Operator and robot, and the dedicated CI role `mfc-demo-gha-e2e`            | M10       | accepted |
| 0070 | ZAP baseline triage policy: report first (`fail_action: false`), then fail the job after triage                | M10       | accepted |
| 0071 | Local demo control server on 127.0.0.1, with the operator's SSO session (no deployed admin page)               | M12       | accepted |
| 0072 | Robot enrolment by one-time token: the private key is generated on the robot (planned, not built)              | M12       | proposed |
| 0073 | E-stop release returns an idle robot to IDLE; any other origin goes to PAUSED                                  | M12       | accepted |
| 0074 | Robot panel: widen toggle and hideable video overlay (amends the locked design, ADR 0004)                      | M12       | accepted |
| 0075 | Compact screens: one layout for a phone in portrait and in landscape (amends the locked design, ADR 0004)      | M12       | accepted |
| 0076 | Operator and Viewer accounts from the local demo page, through the bootstrap script (amends ADR 0071)          | M12       | accepted |
| 0077 | Audit filters as filter expressions on the audit partition (amends ADR 0064)                                   | M12       | accepted |
| 0078 | KPI sheet: two time windows and hero numbers (amends the locked design, ADR 0004)                              | Bonus B   | accepted |
| 0079 | Simulator traffic yield in the navigator, not a robot state                                                    | Bonus M   | accepted |
