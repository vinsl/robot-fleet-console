# ADR 0006 — Region eu-west-3 and Kinesis Video WebRTC availability

- Status: accepted (live preflight pending, see Result)
- Date: 2026-10-31
- Requirements: NFR-PERF-1, NFR-COST-1, SPEC §2

## Context

SPEC §2 places every cloud component in eu-west-3 (Paris) and names eu-west-1 as the fallback if Kinesis
Video Streams (KVS) WebRTC is not available in eu-west-3. Live video depends on KVS WebRTC signaling and
TURN, and NFR-PERF-1 sets a video latency below 500 ms. The project runs in a single region (THREAT_MODEL
R4). The bootstrap variable `region` accepts only eu-west-3 and eu-west-1.

## Decision

Use eu-west-3 for every component. The operator and the robot are in France, which keeps the round trip
short. If the preflight below fails, switch to eu-west-1 before the bootstrap is applied: change the
default of `region` in `infra/bootstrap/variables.tf`, the literal region of the backend in
`infra/bootstrap/versions.tf`, the repository variable `AWS_REGION`, and this ADR.

Evidence: the AWS regional endpoints page (https://docs.aws.amazon.com/general/latest/gr/akv.html) lists
`kinesisvideo.eu-west-3.amazonaws.com` for Europe (Paris). A listed endpoint shows that the service is
offered in the region. It does not prove that the WebRTC signaling API works there, so a live call is
still required.

## Preflight (to be confirmed by the owner)

```bash
aws kinesisvideo list-signaling-channels --max-results 1 --region eu-west-3
```

Result (2026-10-31): the call succeeded and returned an empty `ChannelInfoList`, so the KVS WebRTC API answers in eu-west-3.

The same kind of check must be run for the other services of the design (IoT Core, Cognito, API Gateway
WebSocket, Lambda on arm64) before the milestone that first uses each of them.

## Alternatives considered

| Option              | Pros                                                         | Cons                                         | Why not                                                      |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| eu-west-1 (Ireland) | Named fallback in SPEC §2; allowed by the bootstrap variable | Farther from Paris than eu-west-3            | Kept as the fallback, not the default                        |
| us-east-1           | Earliest region for most AWS features                        | Data leaves the EU; longer distance          | No need for a feature that only this region has in this demo |
| Two regions         | Resilience to a regional outage                              | Doubles the resources and the attack surface | High availability across regions is out of scope (SPEC §11)  |

## Consequences

- The robot and the console both reach KVS in eu-west-3. A regional outage stops video; this is accepted
  in THREAT_MODEL R4.
- The region of an S3 bucket cannot change in place. Once the state bucket exists, moving to eu-west-1 means
  recreating it, which the `prevent_destroy` guard refuses. The preflight must therefore pass before the
  first bootstrap apply.
- A failed preflight changes the places listed in the Decision, the eu-west-3 mentions of SPEC §2 and §3, and
  this ADR. No other code depends on the region name: the ARNs are built from `var.region`.

## Note on the M3 video spike (2026-11-01, ADR 0025)

The spike's pages (2026-11-01, `apps/video-spike`, promoted to `apps/robot-video` in M4, ADR 0037) accepted
eu-west-3 and eu-west-1. Their Content Security Policy named eu-west-3 in each HTML file, so a switch to eu-west-1 would
have needed those edits as well. The spike channel `mfc-spike-video` was created by hand and deleted before M4.
