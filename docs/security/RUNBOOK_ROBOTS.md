# Runbook: robots (register, retire, live checks)

Owner: the repository owner, from their own IAM Identity Center session (`aws sso login`). CI never registers or retires a
robot, and the deploy workflow only runs the read-only `make smoke`. The design is in ADR 0029 (provisioning), ADR 0030
(IoT policy), ADR 0031 (rule deliveries), ADR 0032 (Lambda packaging), and for the agent ADR 0033 (transport) and ADR 0035
(kit and settings). Threats: `THREAT_MODEL.md` T1, T2, T9, T19, T20, T22, R20 to R26, R30 to R32.

Placeholders in angle brackets (`<region>`, `<account>`, `<profile>`) are filled from your session. Never paste a real
account id, certificate, private key or kit into a ticket, a chat, a screenshot or the repository.

## 0. Prerequisites

- AWS CLI v2, `jq`, and bash 4 or later (the Kali VM has them).
- `export AWS_PROFILE=<profile>` for your SSO profile, and `export AWS_REGION=<region>` for the demo region (ADR 0006).
- `aws sso login --profile <profile>` before the first command of a session. Run `aws sso logout` when you are done.
- `terraform -chdir=infra/envs/demo init -reconfigure -input=false` once per checkout: `make smoke` reads the remote state, and
  `make check-tf` leaves a local directory initialised without the backend. This changes no state.

## 1. Precheck before the first deploy of the robot stack

The first apply creates the IoT logging group `AWSIotLogsV2`, whose name AWS fixes. If it already exists, Terraform
would fail to create it.

```bash
aws logs describe-log-groups --log-group-name-prefix AWSIotLogsV2 --query 'logGroups[].logGroupName' --output text
```

The output must be empty. If it prints the name, stop: do not apply, and report it to the main session, which adds an
import block (ADR 0020).

## 2. Deploy and smoke

- The PR touches `infra/`, so the owner reads the plan comment and merges it. The deploy workflow then applies it from
  `main`, and runs `make smoke` at the end of the job.
- The first apply can fail once on IAM propagation, on `aws_iot_logging_options` or on the role alias. Re-run the deploy
  workflow from the Actions page: every creation is idempotent.
- To run the checks yourself: `make smoke` from your session, with `AWS_PROFILE` set. It reads the Terraform outputs
  of `infra/envs/demo` and only reads AWS.

## 3. Operator procedures

The script `scripts/robots-admin.sh` is the only path to the robots function. It invokes the function with your own
IAM session, with one attempt per call and a 90 s read timeout. It never prints the kit. Its output is a summary:
`{"status":...,"robot":{...}}` on success, `{"status":...,"problem":{...}}` on refusal (exit 1).

### 3.1 Register a robot

```bash
scripts/robots-admin.sh register --robot-id probe-01 --site-id paris-01 --name "Probe 01" --type PROBE \
  --design-date 2026-11-02 --simulated true --actor vincent
```

- Success prints status 201 and the robot summary. The answer, which holds the certificate, the private key, the root
  CA and the configuration, is written once to `~/.fleet/robots/probe-01/register-response.json` (file mode 600, directory
  mode 700). Keep it there. The agent reads this file in place, from this directory (ADR 0035, section 6). Do not copy
  it to another machine, and do not keep it in a shared folder: the agent refuses a kit that is not owner-only.
- The script refuses to overwrite an existing answer. Move the old answer away only when you no longer need its kit.
- A refusal prints the problem with its `correlationId`. Find the matching entries in the log group
  `/aws/lambda/mfc-demo-robots`.
- A failed registration leaves the robot `PROVISIONING_FAILED`, and its recorded certificates are revoked by the compensation. Re-send the same command: the
  registration resumes from the failed step (ADR 0029). If the attempt timed out, the record stays `PROVISIONING` for
  120 s, then the same command resumes it.

### 3.2 Retire a robot

```bash
scripts/robots-admin.sh retire --robot-id probe-01 --site-id paris-01 --actor vincent
```

Retirement revokes every certificate of the robot, ends its live session, detaches the policy and the thing, and deletes
the video channel. The thing and the registry record stay, with status `RETIRED`. A repeated retirement answers 200 again
and changes nothing. A robot id is never reused.

## 4. Live checks after the first deploy (P3 acceptance)

Run them in order from your session. Each one is read-only unless it says so.

1. `make smoke` is green. With no robot registered, no ACTIVE certificate exists and the check passes.
2. Register `probe-01` (section 3.1): status 201. Then `make smoke` is green with one ACTIVE certificate mapped to the
   ACTIVE record of `probe-01`. The certificate ARN, read-only:
   `aws iot list-thing-principals --thing-name mfc-demo-probe-01 --query 'principals[0]' --output text`
3. Policy scope, read-only:
   ```bash
   aws iot test-authorization --principal <probe certificate ARN> --client-id mfc-demo-probe-01 \
     --auth-infos 'actionType=PUBLISH,resources=arn:aws:iot:<region>:<account>:topic/$aws/rules/mfc_demo_telemetry/fleet/paris-01/probe-01/telemetry' \
     'actionType=PUBLISH,resources=arn:aws:iot:<region>:<account>:topic/$aws/rules/mfc_demo_telemetry/fleet/paris-01/sim-99/telemetry'
   ```
   Expected: the own topic is ALLOWED, the other is DENIED. If both are DENIED, the API does not resolve thing attributes:
   record it in the checklist and rely on the P4 agent test.
4. Video scope, read-only. Put the KVS master policy of ADR 0030 in a file outside the repository, with the account and
   region of your session (`kinesisvideo:ConnectAsMaster`, `kinesisvideo:GetSignalingChannelEndpoint`,
   `kinesisvideo:GetIceServerConfig` on `arn:aws:kinesisvideo:<region>:<account>:channel/${credentials-iot:ThingName}/*`),
   then wrap it in a one-item JSON array, because the option takes a list of policy strings:
   ```bash
   jq -c -n --rawfile p <policy file> '[$p]' > <list file>
   aws iam simulate-custom-policy --policy-input-list file://<list file> \
     --action-names kinesisvideo:ConnectAsMaster kinesisvideo:ConnectAsViewer \
     --resource-arns <channel ARN of probe-01> arn:aws:kinesisvideo:<region>:<account>:channel/mfc-demo-sim-99/<any id> \
     --context-entries ContextKeyName=credentials-iot:ThingName,ContextKeyValues=mfc-demo-probe-01,ContextKeyType=string
   ```
   Expected: only `ConnectAsMaster` on the channel of `probe-01` is allowed. The channel ARN of `probe-01` comes from
   `aws kinesisvideo describe-signaling-channel --channel-name mfc-demo-probe-01 --query ChannelInfo.ChannelARN --output text`.
5. Retire `probe-01` (section 3.2): status 200. Then `aws iot describe-certificate --certificate-id <id> --query
certificateDescription.status --output text` prints `REVOKED`; `aws kinesisvideo describe-signaling-channel --channel-name
mfc-demo-probe-01` reports that the channel does not exist; `make smoke` is green.
6. Record the results in `docs/security/CHECKLIST.md` (Robot / IoT section) and in `docs/JOURNAL.md`, with the date.

## 5. Recovery

- **A certificate that is ACTIVE but outside the registry** (`make smoke` fails with "ACTIVE certificate ... has no ACTIVE
  registry record"). Identify it with `aws iot list-certificates` and `aws iot list-principal-things --principal <ARN>`.
  Revoke it only after you have checked its thing: `aws iot update-certificate --certificate-id <id> --new-status REVOKED`.
  This changes the account; it is your decision in your session. Then run `make smoke` again.
- **INACTIVE certificates** (a warning in `make smoke`). They carry no rights. They are evidence of an interrupted
  registration: keep them, and report the count to the main session.
- **Timeout or unhandled error of a registration.** Wait 120 s, then send the same command again: a stale `PROVISIONING`
  record is resumed. If it still fails, retire the robot id and register a new one.
- **Lost kit** (the answer file is gone, or never arrived). The key cannot be re-issued. Retire the robot, then register a
  new robot id.
- **Suspected exposure of a kit.** Retire the robot at once. Its certificates are revoked and its session is ended. Register
  a new id with a new kit, and record the incident in `docs/JOURNAL.md`.
- **A refusal of `invalid-request`.** The script checks the shape first, so a refusal means the function disagrees with a
  value. The problem detail is generic; the function's log group names the refused fields by path, never their values.

## 6. Live checks of the agent (P4 acceptance)

Run them in order on the machine that holds the kit (the Kali VM), from your own session. They are the MQTT half of the M4
gate and the agent's live behaviour. Nothing here changes AWS, except the dev e-stop of section 6.3, which is a publish on
the robot's command topic. The agent's logs carry no endpoint and no account id, so a terminal capture shows neither.
Screenshots follow `docs/screenshots/README.md`; blur anything that is not the thing name or an event.

### 6.1 Run the agent and see it connected

```bash
make agent ROBOT=<robot-id>
```

- The AWS IoT console shows the thing `mfc-demo-<robot-id>` as connected. Screenshot `06-iot-robot-thing-connected.png`.
- The terminal prints one JSON object per line. It includes `agent.booted`, `link.connected`, `link.subscribed` and
  `telemetry.summary`. Screenshot `07-agent-json-logs.png`. A line that shows an endpoint or an account id is a leak: stop,
  and record it in `docs/JOURNAL.md`.
- Log level: keep `FLEET_LOG_LEVEL` at `INFO` or lower for the probe of section 6.2.

### 6.2 Isolation probe, with the agent stopped

Stop the agent first (Ctrl+C). The probe connects with the robot's own identity and client identifier. A second connection
with the same identifier makes the broker drop the agent (R32).

```bash
cd agent
uv run fleet-agent probe-isolation --robot-id <robot-id> --other-robot-id <test-robot-id>
```

- Use a registered test robot as `--other-robot-id`, never a robot in service. The probe publishes a fake heartbeat and a
  fake acknowledgement on the robot's own topics, and on the other robot's topics if the policy were broken (R32).
- Expected: nine `probe.result` lines, each with `"result":"PASS"`, and exit code 0. The nine checks are own events
  publish, own command subscribe, own acknowledgement publish (all allowed); other robot's events publish, other robot's
  acknowledgement publish, other robot's command subscribe, own command publish, wildcard command subscribe, and a second
  client identifier under the same certificate (all denied).
- Exit code 1 means at least one check failed. The line with `"result":"FAIL"` names the check.
- The broker's refusals are logged at ERROR in the log group `AWSIotLogsV2`, as `AUTHORIZATION_FAILURE` entries. Read them
  in the console, from your session.
- If `other-client-connect` passes while the own checks read `NOT_CONNECTED`, the certificate may be revoked rather than the
  policy wrong (R32). Check the certificate status before you read the policy result.
- Record the result, with the date, in `docs/security/CHECKLIST.md` (Robot / IoT) and in `docs/JOURNAL.md`.

### 6.3 Dev e-stop and the latch

With the agent running in a second terminal, build one ESTOP command for the robot. Write it outside the repository, and
delete the file after use.

```bash
cd agent
uv run fleet-agent estop-command --robot-id <robot-id> > ~/estop-<robot-id>.json
```

Read the data endpoint (read-only), then publish the command with your SSO session:

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
aws iot-data publish --topic fleet/<site-id>/<robot-id>/cmd --qos 1 \
  --payload fileb://$HOME/estop-<robot-id>.json --endpoint-url https://<ats endpoint>
```

- The agent logs `command.acked`. The file `~/.fleet/robots/<robot-id>/estop.latch` exists, and
  `stat -c %a` on it prints `600`.
- Restart the agent. It boots in ESTOP, and logs `agent.boot_latched`.
- Reset: stop the agent, delete `~/.fleet/robots/<robot-id>/estop.latch`, then start the agent again. The reset is local
  and physical: whoever is at the robot's machine decides. The console's release command arrives with M9 (ADR 0028).

### 6.4 Network cut

With the agent running, switch the VM's network adapter off for 30 s, then on again. Cut `eth0` (or untick the cable in VirtualBox),
not `lo`: the loopback interface carries no traffic to AWS.

- The agent logs `link.lost`, then reconnects with jittered delays, and telemetry resumes (`link.connected`,
  `telemetry.summary`).

### 6.5 Clean stop

Press Ctrl+C in the agent's terminal, or send one SIGTERM to the Python process.

- Target the Python process only, found with `ps -eo pid,ppid,cmd | grep "[m]arso-agent run"`. A `pkill -f` on the
  command line also hits the `uv run` wrapper, which forwards the signal: the agent then receives two signals and exits at
  once with code 130, as designed for a forced stop, without `agent.stopped`.

- The agent logs `agent.stopping` and publishes `GOING_OFFLINE` as its last message, then logs `agent.stopped`. The shell
  reports exit code 0.
- The presence event of the thing in the IoT console shows a client-initiated disconnection, not a lost link.

The exit code of `make agent` is not the agent's own: `make` reports 130 for an interrupted recipe. To read the
agent's exit code, run `cd agent && uv run fleet-agent run --robot-id <robot-id>` and read `$?` after it stops, or read
the `agent.stopped` line.

Record each result with the date in `docs/security/CHECKLIST.md` and `docs/JOURNAL.md`. The main session ticks the M4 plan
items after the results are recorded.

## 7. Local video page and video isolation (P5 acceptance)

The agent serves the robot's camera page on `127.0.0.1` (ADR 0036, ADR 0037, THREAT_MODEL T24). The live checks below
are pending: none has been run yet. Record each result with its date in `docs/security/CHECKLIST.md` and
`docs/JOURNAL.md`. Nothing here changes AWS resources. The probe in 7.3 makes only read-only requests.

### 7.1 Local page

Prerequisites: the kit is in place, the webcam is attached with `webcam attach` (JOURNAL 2026-11-01), and the agent
is not yet running.

1. `make agent ROBOT=<robot-id>`. Standard error prints the address of the page once. Open it in a **private window** of
   the VM browser (Firefox or Chromium), and allow the camera.
2. Expect: the status line goes from "Starting the camera…" to "Connecting to the signalling channel…" and then "Live: the camera is shared."; the preview shows; "Viewers 0/3";
   no banner while the robot is idle. The address bar becomes `http://127.0.0.1:<port>/`, because the fragment is removed.
   No credential is visible on the page.
3. In the agent's terminal, the JSON lines are `video.listening` (the port only), `video.claimed` and
   `video.credentials_ok`. A line that contains the address, a key or `claim=` is a leak: stop the agent, record it in
   `docs/JOURNAL.md` and do not continue.
4. Reload the page. It asks for a new address. Run `kill -USR1 <pid>` on the agent's Python process (see the note in 6.5), which
   prints a new address on standard error. Open that address.
5. Banner: send the dev e-stop (6.3). The page shows the octagon banner "EMERGENCY STOP" within about 2 s. Reset the latch
   as 6.3 describes; the banner disappears after the agent restarts.
6. Ctrl+C the agent. Within about 5 s the page shows "The agent stopped answering. The camera is off.", and the camera light goes off.

### 7.2 Negative checks (about one minute)

With the agent running, from the VM terminal (replace `<port>` with the port of `video.listening`):

- `curl -i http://127.0.0.1:<port>/api/status` answers `401`.
- `curl -i -H 'Host: evil.example' http://127.0.0.1:<port>/` answers `400`.
- `curl -i -X POST http://127.0.0.1:<port>/api/claim -H 'Content-Type: application/json' -d '{}'` answers a `4xx`. The
  refused body keeps the token: afterwards, the address printed at start still claims the page in a private window.
- `curl -i http://127.0.0.1:<port>/` shows `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
  `X-Frame-Options: DENY`.
- `ss -ltn | grep <port>` shows `127.0.0.1:<port>` only, never `0.0.0.0` or `::`.

### 7.3 Video isolation gate, run twice

This is the video half of the M4 gate: robot A cannot open robot B's video channel. The agent may keep running.

```bash
cd agent && uv run fleet-agent probe-video-isolation --robot-id <A> --other-robot-id <test robot B>
```

- Expect six `PASS` lines and exit code 0. Run it a second time, on the same day or the next one.
- Any `INCONCLUSIVE` counts as a failure, whatever the other lines say. `CONTROL_FAILED` on checks 3 to 5 means that check
  2, the positive control, did not pass, so the three refusals prove nothing.
- If check 3 reads `INCONCLUSIVE` (a `404` on the synthetic channel name), read the real channel ARN of robot B with
  `aws kinesisvideo describe-signaling-channel --channel-name mfc-demo-<B>` (read-only), then run the probe again with
  `--other-channel-arn <that ARN>`.
- Check 6 passes only when robot A's own credentials fetch again and succeed right after the refusal. Otherwise it
  reads `INCONCLUSIVE`, and the probe fails it.

Optional, read-only policy simulation of the same grant:

```bash
aws iam simulate-principal-policy --policy-source-arn <ARN of role mfc-demo-robot-kvs-master> \
  --action-names kinesisvideo:ConnectAsMaster --resource-arns <channel ARN of B> \
  --context-entries ContextKeyName=credentials-iot:ThingName,ContextKeyValues=mfc-demo-<A>,ContextKeyType=string
```

Expect `implicitDeny`. The same call with B's own thing name and B's channel ARN expects `allowed`. Record the date, the
two runs of the six results, and the simulation in `docs/security/CHECKLIST.md` (Robot / IoT) and `docs/JOURNAL.md`.

The probe does not cover `ConnectAsMaster` on B's WSS endpoint. Check 3 already blocks that endpoint for robot A, and the
policy text is covered by the Terraform tests `video_master_role_masters_only_the_own_channel` and
`video_master_role_is_bound_to_the_alias_and_the_credentials_service`. Credentials issued before a policy change stay
valid up to 3600 s (THREAT_MODEL T8, residual).

### 7.4 Cost

The next day, check Cost Explorer for Kinesis Video Streams and AWS IoT. Expected: below 0.10 USD for the P5 work and the
demo (`docs/COSTS.md`). Record the line in `docs/COSTS.md`.
