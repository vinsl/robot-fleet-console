# ADR 0025 — Video spike: hand-made signaling channel and the SSO session pasted into local pages

- Status: accepted
- Date: 2026-11-01
- Requirements: FR-VID-1, FR-VID-2, NFR-PERF-1, NFR-COST-1, SEC-SEC-1

## Context

The spike must show webcam video from the Kali VM in a browser, and measure the latency, before M4 designs the
robot's video path. AWS provider 6.71.0 (the version pinned in `infra/envs/demo`) has no resource for a
signaling channel. A Terraform path would need a CloudFormation stack, a bootstrap grant applied by the
operator, scoped spike roles and an infrastructure PR, with two security reviews, and the same work again to
remove them. M4 (IoT credentials provider) and M6 (identity pool) replace every identity that the spike would
create, so that work would be thrown away. The deadline is the checkpoint of 3 November and the report of 6 November.

## Decision

- **The channel is made by hand.** The operator creates `mfc-spike-video` (SINGLE_MASTER, 60 s message TTL,
  tagged `project`, `env`, `component = spike`, `owner`) from their own SSO session, and deletes it before M4. This is a
  time-boxed exception to "infrastructure reaches AWS only through the CI deploy workflow" (repository rules). It is the
  same shape as the exception of ADR 0024. The channel is in no Terraform state.
- **The channel name is outside `mfc-demo-*`.** The CI deploy role may act on `channel/mfc-demo-*/*` only
  (`kinesisvideo:*`), and the workload boundary follows the same prefix. A name outside it keeps the spike channel out
  of reach of CI and of every robot role. An earlier draft used `mfc-demo-spike-video`; the operator deletes that
  channel if it exists, then creates the new one. The commands are in `apps/video-spike/README.md`, step 12:

  ```bash
  arn="$(aws kinesisvideo describe-signaling-channel --region eu-west-3 --channel-name mfc-demo-spike-video --query ChannelInfo.ChannelARN --output text)"
  aws kinesisvideo delete-signaling-channel --region eu-west-3 --channel-arn "$arn"
  aws kinesisvideo create-signaling-channel --region eu-west-3 --channel-name mfc-spike-video \
    --channel-type SINGLE_MASTER --single-master-configuration MessageTtlSeconds=60 \
    --tags Key=project,Value=mfc Key=env,Value=demo Key=component,Value=spike Key=owner,Value=vincent
  ```

- **The pages receive one session line.** `scripts/mint-session.sh` builds it from `aws configure export-credentials`
  and `aws kinesisvideo describe-signaling-channel`, in a terminal only. The pages check it with zod: version 2,
  region, the spike channel ARN, temporary `ASIA` keys, at least 5 minutes of validity, no unknown key. It is kept in
  page memory only.
- **The pasted credentials are the operator's AdministratorAccess role session.** This is accepted for the spike only
  (THREAT_MODEL R19). The pages use them only for `GetSignalingChannelEndpoint`, `GetIceServerConfig` and the signed
  WebSocket of the channel.
- **Agents never run the create, delete or mint commands.** Create and delete change AWS resources, and the mint
  command prints credentials. The repository rules forbid an agent to do either.
- **The pages are the workspace package `apps/video-spike`.** They are served on 127.0.0.1:8765 (on the VM) and through
  a private Codespaces port (for the viewer). Each HTML file carries a Content Security Policy meta tag. They are
  English-only developer tools, outside the console UI rules.
- **The spike schema stays in the package.** `SessionBundleSchema` is used by the spike only, so it lives in
  `apps/video-spike/src/lib/session-bundle.ts`, not in `packages/protocol` (repository rules shared-schema rule).

## Alternatives considered

| Option                                                                     | Pros                                                                                        | Cons                                                                                                                                  | Why not                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFormation stack in Terraform, with two scoped roles (the full design) | Infrastructure through CI; sessions limited to one channel and one side; rehearses SEC-ID-2 | A bootstrap PR applied by the operator, an infrastructure PR, two security reviews, and the same to remove it in M4                   | About half a day before the checkpoint, for identities that M4 replaces                                                                                                                                     |
| Hand-made scoped IAM role assumed with a 15-minute session                 | Scoped rights and a short session instead of the administrator role                         | A role and a trust policy created by hand, outside state; the same bootstrap and infrastructure changes and merges as the full design | The owner would need the role and its trust policy created before the run, which is the full design's work in another form. M4 and M6 replace these identities anyway, and the deadline left no room for it |
| `hashicorp/awscc` provider                                                 | Native resource                                                                             | A second provider; Cloud Control actions only accept `Resource "*"`; still a bootstrap grant                                          | Same cost, wider grant                                                                                                                                                                                      |
| IoT credentials provider or identity pool now                              | The final identities                                                                        | M4 and M6 work                                                                                                                        | The spike exists to de-risk video first                                                                                                                                                                     |

## Consequences

- No Terraform drift and no destroy-guard impact: the channel is in no state, and no plan reads it.
- Cost: 0.03 USD for a month in which the channel is active, 0 when idle, 0 after deletion.
- The pasted session has administrator rights until its expiration (up to the permission set's session duration, 1 hour
  by default). The real value is confirmed by the owner in IAM Identity Center before the run. The controls are a private
  browser window, clearing the terminal and the clipboard, no screenshot of the session, closing the browser, and
  `aws sso logout` at the end, which clears the AWS CLI cache in `~/.aws/cli/cache` in the Codespace. `aws sso logout`
  does not revoke credentials already issued. THREAT_MODEL R19 and T8 record the risk.
- SEC-ID-2 (the robot's KVS permission set, `ConnectAsMaster` only) is first proven in M4, by the denied-access test
  planned there ("robot A cannot open robot B's video channel").
- The channel must be deleted before M4. It is outside `mfc-demo-*`, so no CI role or robot role reaches it, and M4
  must not leave an unmanaged channel in the account.
- The `@smithy/core` 3.36.0 deprecation notice of the AWS SDK (a custom logger redaction bug) does not apply today. No
  custom logger is passed to the AWS SDK clients, and the KVS SDK logger is silenced. The notice is accepted without an
  override. Condition: never pass a logger to these clients unless `@smithy/core` is 3.38.1 or later;
  `IceServerList[].Password` is a sensitive field inside a list. The lockfile pins 3.36.0 today.
- The eu-west-1 fallback (ADR 0006) needs more than the region list: the `connect-src` of the Content Security Policy
  names eu-west-3 in each of the three HTML files, and the endpoint tests use eu-west-3 names.
- The pages are English-only and carry no UI i18n. They are removed or promoted in M4.

## Result

Run of 2026-11-01, master in the Kali VM (VirtualBox 6.1.46, external LifeCam through `webcam attach`), viewer in the
host browser through a private Codespaces port. Live video worked end to end through KVS (screenshot 05).

| Configuration | n   | Skipped | Median (ms) | p95 (ms) | Min (ms) | Max (ms) | ICE path            | Resolution | FPS           |
| ------------- | --- | ------- | ----------- | -------- | -------- | -------- | ------------------- | ---------- | ------------- |
| A             | 5   | 10      | 2238        | 2435     | 859      | 2435     | srflx → relay (udp) | 640x480    | 3.0, 2.0, 1.0 |

The latency figure is **not conclusive**: only 5 valid samples against the 25 required, and the camera delivered 1 to
3 frames per second, so the filmed clock digits were blurred and most readings were skipped. It is dominated by the
camera and the jitter buffer at that frame rate, not by the transport. The WebRTC statistics at 1 frame per second show a
round-trip time of 40 ms, a decode time of 6.2 ms and a jitter buffer of 891 ms. Configurations B to D were not run.

Findings for M4:

- FR-VID-1 (720p at 15 frames per second) is **not met** in the VM. The VirtualBox webcam emulation exposes a single
  control (brightness), so exposure and frame rate cannot be set, and the frame rate stayed between 1 and 3.
- The ICE path went through TURN (`relay`): the direct path was not found in this network. KVS TURN works.
- Decision (the owner, 2026-11-01): continue with this camera, since video quality is not the deciding criterion of the
  demo. Running the master page in the Windows host browser, where the webcam runs natively, is kept as an optional
  improvement (plan B of the design) for after M9, otherwise a documented improvement path.
