# ADR 0030 — IoT policy bound to the thing name and to provisioner-set thing attributes

- Status: accepted
- Date: 2026-11-02
- Requirements: SEC-ID-1, SEC-ID-2, SEC-IAM-1, FR-ROB-1, T1, T8, R11, R20

## Context

SEC-ID-1 (SPEC section 10) asks for one IoT policy that restricts a robot to its own client id and its own topics,
with `${iot:Connection.Thing.ThingName}` and `iot:Connection.Thing.IsAttached`. The thing name is
`mfc-demo-<robotId>` (ADR 0020), but the topics are `fleet/<siteId>/<robotId>/...` (SPEC section 5). IoT policy
variables resolve to the value of one thing field, so the thing name cannot stand for the robot segment of a topic
filter. The client id can be bound to the thing name, and the topics can be bound to attributes of the thing. The
guarantee is the same: a robot connects as its own thing and touches only its own topics. Robot isolation has to
hold against a compromised robot (THREAT_MODEL T1), and the provisioner is the only writer of the thing attributes.

## Decision

- **One policy, `mfc-demo-robot`, for every robot.** It allows `iot:Connect` only on the client id
  `${iot:Connection.Thing.ThingName}` with `iot:Connection.Thing.IsAttached` true. It allows `iot:Publish` only on the
  three rule topics `$aws/rules/mfc_demo_{telemetry,events,acks}/fleet/<site>/<robot>/...`, `iot:Subscribe` only on the
  robot's own command filter, `iot:Receive` only on the own command topic, and `iot:AssumeRoleWithCertificate` only
  on the video role alias. The site and robot segments are `${iot:Connection.Thing.Attributes[siteId]}` and
  `${iot:Connection.Thing.Attributes[robotId]}`. The policy has no `*`, `+` or `#`.
- **Attributes are written by the provisioner only.** The robots function sets `robotId` and `siteId` when it creates
  the thing. No robot holds `iot:UpdateThing`, so a robot cannot change the attributes that select its topics.
- **One thing per certificate.** The certificate is attached with the `EXCLUSIVE_THING` type, so no other thing can
  be bound to it.
- **Video master role.** The KVS master role trusts only `credentials.iot.amazonaws.com`, with `aws:SourceAccount`
  and `aws:SourceArn` equal to the role alias ARN, and it grants `ConnectAsMaster`, `GetSignalingChannelEndpoint` and
  `GetIceServerConfig` on `channel/${credentials-iot:ThingName}/*`. It has no viewer or media action (SEC-ID-2).
- **Confused-deputy conditions.** The rules role and the logging role trust `iot.amazonaws.com` with
  `aws:SourceAccount` and `aws:SourceArn` set to the account's IoT ARN. This limits R11 for these two roles.
- **Single policy, checked twice.** `scripts/check-iot-inventory.sh` (repository, `make check-tf`) declares exactly one
  `aws_iot_policy` under `infra/`. `scripts/smoke-iot.sh` (live, `make smoke`) checks that the account's policies are
  exactly `mfc-demo-robot` and that every ACTIVE certificate carries only that policy (THREAT_MODEL R20).
- **SEC-ID-1 wording.** SPEC section 10 (SEC-ID-1) describes this binding: the client id is bound to the thing name
  with `iot:Connection.Thing.IsAttached` required, and the topics are bound to the thing attributes `siteId` and
  `robotId`, written only by the robots function. The SPEC was aligned with this ADR on 2026-11-02.

## Alternatives considered

| Option                                                 | Pros                                  | Cons                                                                         | Why not                                        |
| ------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| One IoT policy per robot                               | Each policy names its robot literally | Many policies to inventory; the R20 check becomes a pattern check            | The smoke check must stay exact with one name  |
| Rename the topics to the thing names                   | Thing-name variable works as written  | Changes the protocol topics of SPEC section 5 and the agent                  | The protocol is fixed by ADR 0027              |
| Thing attributes writable by the robot (`UpdateThing`) | Robot could update its own attributes | A compromised robot could select another robot's topics                      | Attributes must come from the provisioner only |
| Non-exclusive thing attachment                         | Simpler attach call                   | A certificate could be bound to several things, so the identity is ambiguous | One certificate, one thing                     |

## Consequences

- The policy depends on attributes being set at creation. `aws iot test-authorization` may not resolve thing attributes;
  if it does not, the live check of RUNBOOK_ROBOTS is recorded as not conclusive and the P4 agent test covers it.
- The policy is written with `jsonencode()` of a local (ADR 0032), and the `$${...}` escapes keep the IoT variables
  literal.
- A second IoT policy declared in code is caught by the repository check (`make check-tf`, in CI). A policy created by
  hand in the console is caught by the live smoke check (`make smoke`, after each deploy), which lists the account's
  policies by name. The smoke check does not read the content of any policy.
- Accepted risk R20 remains: a provisioner with the actions of ADR 0029 can bind a certificate to any robot thing.
