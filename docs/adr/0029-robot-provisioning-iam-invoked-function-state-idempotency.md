# ADR 0029 — Robot provisioning: IAM-invoked function, state-based idempotency, kit never stored

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-1, FR-ROB-2, SEC-ID-1, SEC-LOG-1, NFR-REL-2, NFR-OBS-1, T2, T7, T9, T13, R20, R23, R24, R25

## Context

Registering a robot creates an IoT thing, an X.509 certificate with its private key, a policy attachment and a
KVS signalling channel. The answer carries the private key once, the kit: FR-ROB-1 says the key is never stored
in AWS, so the kit cannot be cached or re-issued. A registration can be interrupted, the SDK retries a timed-out
call, and an operator may send the same command twice. Each of these must neither mint a second key pair nor leave
an orphan that holds rights. In M4 the caller is the owner's own session, because the HTTP route with the JWT Admin
check arrives in M6 (decided on 2026-11-01). The M5 consumers need a registry and an audit trail of registrations
before they exist, so their tables and the telemetry queue are created now.

## Decision

- **Invocation.** The `mfc-demo-robots` function is invoked directly with IAM by `scripts/robots-admin.sh`. It has no
  resource policy, no event source and no HTTP route. Asynchronous retries are 0 and the maximum event age is 60 s, so
  an asynchronous invocation runs at most once; it would still lose the kit, which is why the script is the only
  documented caller (R24). The script makes one attempt (`AWS_MAX_ATTEMPTS=1`) with a 90 s read timeout, above the
  function timeout of 30 s.
- **Idempotency by registry state, not by response.** The claim of the robot id and the robot record are written in
  one `TransactWriteItems` with a client request token. Each later change to the record is a conditional write on its
  `version`. A retried call finds its own record by `lastCorrelationId` and resumes it. A failed registration is
  resumed by a new call with the same id, from `PROVISIONING_FAILED` or from a `PROVISIONING` record silent for more
  than 120 s. Powertools idempotency is not used for this function: it caches the response in DynamoDB, and the
  response holds the private key (S4 of the M4 design).
- **Order of the provisioning steps.** Thing, then the certificate created **inactive**, then the record of the
  certificate, the policy, the exclusive thing attachment, the channel, and only then the activation of the
  certificate as the last IoT step. An inactive certificate has no rights, so a crash leaves nothing usable, and the
  smoke check (ADR 0029, THREAT_MODEL R20) can count inactive certificates as warnings.
- **Compensation.** Any failure after the first write revokes every certificate that was recorded or created,
  detaches the policy and the thing, deletes the channel and marks the record `PROVISIONING_FAILED`, then answers
  `502 provisioning-failed`. The compensation is best effort and logged; a failed mark leaves a stale `PROVISIONING`
  record, which the next call resumes.
- **Retirement.** Revoke every certificate of the robot, end the live session, detach the policy and the thing,
  delete the channel. The thing and the registry record (`RETIRED`) are kept. Robot ids are never reused, and
  certificates are never deleted (`iot:DeleteCertificate` is never granted).
- **Keeping the kit out of the telemetry.** The IoT client that creates certificates has `maxAttempts: 1`, so a
  retry never mints a second key pair. That client is not wrapped by the X-Ray tracer, the tracer does not capture
  responses (`POWERTOOLS_TRACER_CAPTURE_RESPONSE=false`), and the handler is not wrapped by `captureLambdaHandler`.
  Logs carry the step, the error name and the certificate id, never the body of the answer.
- **Root CA.** The Amazon Root CA 1 certificate is a constant in the code, and a unit test pins its SHA-256
  fingerprint. The function does not fetch it at run time, so it needs no egress.
- **Endpoints.** The IoT data and credentials endpoints reach the function as environment variables read from
  `aws_iot_endpoint` data sources at plan time. `iot:DescribeEndpoint` is not granted, because that action has no
  resource type.
- **Audit.** The audit item is written after the outcome (`SUCCEEDED`, `REFUSED` or `FAILED`), best effort. A failed
  audit write logs at ERROR and counts a metric, but does not fail a registration whose kit already exists: failing
  after activation would destroy a kit that cannot be re-issued (R25). CloudTrail records the IoT management calls
  as the backstop.
- **Tables and queue of M4 (S2).** This stage creates the `fleet` and `events` tables with the full key schema and
  indexes of SPEC section 8, and the telemetry queue with its dead-letter queue. M5 adds the `connections` and
  `idempotency` tables and the consumers. PLAN M5 says so.

## Alternatives considered

| Option                                                | Pros                       | Cons                                                                               | Why not                             |
| ----------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| Powertools idempotency on the request                 | Standard, little code      | Caches the response, which holds the private key in DynamoDB                       | Breaks FR-ROB-1                     |
| Certificate active at creation (`setAsActive: true`)  | One call fewer             | A crash mid-way leaves an active certificate with the policy still to attach       | Orphans must have no rights         |
| Robots route on API Gateway now                       | Matches SPEC 4.3 literally | Needs the JWT Admin check and the console work of M6; widens the internet exposure | Deferred to M6 (decided 2026-11-01) |
| Delete the thing on retirement and allow the id again | Simpler lifecycle          | Loses the evidence, and a reused id could inherit a stale grant or history         | Evidence and isolation first        |
| Default SDK retries on certificate creation           | Fewer errors surface       | A retried call mints a second key pair, and only one is delivered                  | Single attempt for that call        |
| Store the kit in Secrets Manager for later retrieval  | Re-download possible       | The key then lives in AWS, against FR-ROB-1, and costs a secret                    | Rejected by the requirement         |
| Fetch the root CA at run time                         | No constant to maintain    | Egress and an unpinned download on the path of a private key                       | Pinned constant with a test         |

## Consequences

- The operator must keep the kit file that `scripts/robots-admin.sh` writes (mode 600, directory 0700). A lost kit
  cannot be re-issued: the robot is retired and a new id is used (RUNBOOK_ROBOTS).
- A crash during provisioning is recovered by sending the same command again. No cleanup job is needed in M4.
- The function is called a few dozen times in the whole demo, so its cost is nil (COSTS.md, section M4 P3).
- The certificate and policy actions are granted on `*` or `cert/*` because AWS has no resource type for them. This
  is accepted risk R20, and the smoke check of ADR 0030 detects a certificate outside the registry.
- Accepted risks R23 (the actor is self-declared until M6), R24 (asynchronous invocation) and R25 (best-effort
  audit) are recorded in `docs/security/THREAT_MODEL.md`.
