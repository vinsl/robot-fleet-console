# ADR 0072 — Robot enrolment by one-time token, so the private key never leaves the robot

- Status: proposed (planned, not built)
- Date: 2026-11-04
- Requirements: none in SPEC (planned operator feature, bonus in `docs/ROADMAP.md`); SEC rules of `docs/security/CHECKLIST.md`
- Implemented in: not yet. It would touch `services/api/src/` (the robots function), `infra/modules/` (the IoT policy), and
  `docs/security/THREAT_MODEL.md`. None of it exists today.

## Context

Today a robot is registered by `scripts/robots-admin.sh register` from the operator's SSO session. The robots function
creates the IoT thing, an X.509 certificate and its private key (`services/api/src/domain/robots/kit.ts`), and the answer
returns `privateKeyPem` once. The script writes that answer to `~/.fleet/robots/<robot-id>/register-response.json` on the
machine that ran the registration (mode 600). AWS does not keep the key (ADR 0029).

This works for simulated robots, which run on the same machine as the operator. A real robot runs on the Kali VM, so it
must be registered on that machine, with the SSO session of that machine. The private key is therefore generated in the
cloud and carried to the robot, and the operator's session is needed on the robot. The demo interface (ADR 0071) lists
robots and does not add them, for the same reason. Multi-site work (bonus in `docs/ROADMAP.md`) also needs a way to attach
a robot to a site from the interface, without a terminal.

## Decision

Planned, not built. Enrolment moves the key generation to the robot:

1. The interface (or an Admin, through the robots function) creates a `PENDING` robot record with its site, name and type,
   and a short-lived single-use enrolment token. The token is shown once and is stored only as a hash.
2. On the robot, `fleet-agent enrol --token <token>` generates the private key locally, builds a certificate signing
   request (CSR), and sends the CSR with the token to the robots function.
3. The function checks the token (hash, expiry, single use, and the record is `PENDING`), signs the CSR with the CA
   Certificate, creates the IoT thing and the policy attachment, activates the certificate, and returns the certificate
   only. The key never leaves the robot.
4. The robot writes its key and certificate to its own kit directory (mode 600). The token is consumed on success.

The change needs three parts that do not exist today:

- **Robots function.** A `PENDING` state, a token table or record with a hash and an expiry, a `CreateCertificateFromCsr`
  path instead of `CreateKeysAndCertificate`, and a single-use check with a conditional write.
- **IoT policy.** The enrolment call needs its own minimal permission, and the robot needs a way to call it before it has
  a certificate. The policy of ADR 0030 is bound to the thing, so the bootstrap path must be decided and reviewed.
- **Threat model.** New rows for token guessing and replay, a CSR that asks for another thing name, a stolen token, and the
  enrolment endpoint reachable before the robot has an identity. `security-reviewer` reviews it before any build.

Multi-site support comes with it: the token carries the site (and later the tenant), so the interface can attach a robot
to a site by creating the token for that site, and the robot cannot enrol into another one.

## Alternatives considered

| Option                                                                                       | Pros                                                       | Cons                                                                                                         | Why not                                                                                              |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Keep the current flow: the key is returned once and written on the registering machine       | Built and tested; the simulators use it                    | A real robot must be registered on its own machine with the operator's session; the key crosses the API once | Acceptable for the demo, and not the target. Kept until ADR 0072 is built                            |
| Copy the kit from the operator machine to the robot by hand                                  | No code                                                    | The key is copied by a person, and it is in one more place                                                   | Worse than the current flow, with no audit                                                           |
| Certificate issued by AWS IoT provisioning templates (fleet provisioning, claim certificate) | Standard AWS mechanism, the key is generated on the device | A claim certificate ships on every robot; a template and its policy are more to review than the token        | Larger change with a long-lived claim credential; the one-time token is shorter-lived and single use |
| Let the interface create the certificate and push the kit over MQTT                          | One click                                                  | The key crosses the cloud and the broker                                                                     | Breaks the rule that the key is generated on the device                                              |

## Consequences

- Easier: a real robot is enrolled from the interface and the robot's own machine, and the key never leaves the device.
  Multi-site attachment fits the same token.
- Harder: a new state in the robot lifecycle, a token store, a new call in the agent, and a new IoT policy path to review.
  Retirement and the robot janitor must know the `PENDING` state.
- Until it is built, a real robot is registered on its own machine (`scripts/robots-admin.sh register` from that machine
  with its own SSO session, then `make agent ROBOT=<id>`), and the interface only lists robots.
- Security: no change to the delivered scope. The planned threats go into `docs/security/THREAT_MODEL.md` when the work is
  scheduled, not before.
