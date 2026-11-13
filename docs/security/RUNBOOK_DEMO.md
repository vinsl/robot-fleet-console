# Runbook: the local demo control

Operator steps for `make demo`, `make links` and `make demo-ui`. The design and its threats are in ADR 0071 and
`docs/security/THREAT_MODEL.md` (T64 to T69, R101, R102). The page runs on the operator's machine only.

## Prerequisites

- The repository is checked out, and `git pull` has run on this machine. Nothing updates automatically.
- The dev container tools are installed: `aws`, `uv`, `flock` and `timeout` (see `.devcontainer/post-create.sh`).
- The stack is deployed, so that `terraform output` answers in `infra/envs/demo/`.
- Your IAM Identity Center permission set allows the actions listed below.

## Start the session

```bash
aws sso login            # opens the browser login; the session expires on its own schedule
make demo                # N simulators, default 9: make demo N=5 for another count
make links               # the console, the Cognito user list and the IoT thing hub
make demo-ui             # the control page on 127.0.0.1:8765; make demo-ui PORT=9000 for another port
```

- `make demo` checks the session first. Without a usable session it stops with `run: aws sso login`, and it starts
  nothing.
- A second `make demo` starts nothing and prints the links. The simulators already hold their lock.
- The simulators stop by themselves after 2 h. `make demo-stop` stops them at any time and disables the ingest consumer.

## Open the page

`make demo-ui` prints the start URL on standard error. The token is in its fragment (`#token=`). Open that exact URL in a browser on the same machine. The token is printed once: restart the
page to get a new one. Do not paste the URL into a chat, a ticket or a screenshot.

The browser does not send the fragment to any server. The page refuses a request whose Host is not `127.0.0.1` or
`localhost`, and a POST whose Origin is not the page's own.

## Codespace

- In VS Code, open the **Ports** view and forward the page port (default 8765) to `localhost`.
- Set its visibility to **Private**. Never set it to Public. Forwarding the port publicly would expose the page to the
  internet; the Host check refuses such a request, but the setting must stay Private (T67).
- Open the forwarded address from the same Codespace session. Do not share it.

## What each control does

| Control          | Effect                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start            | Enables the ingest consumer, registers missing simulated kits, starts the simulators, and waits until they hold their lock. It runs in the background, so the page polls the status. |
| Stop             | Cancels a Start that is still running, stops the simulators, then disables the consumer. It always disables the consumer, even when the simulator stop fails.                        |
| Copy and Share   | Copy or share the console URL. The URL carries no token. Share uses the system share sheet when the browser has one.                                                                 |
| Refresh (robots) | Reads the robots of the site again. The page does not refresh them by itself.                                                                                                        |

- Stop preempts Start: if a Start waits for the lock or for a step, Stop ends it at the next step boundary.
- Start is idempotent: when the simulators run, Start answers with the current status and starts nothing.
- The real robot has no Start or Stop here. Run it on its own machine: `make agent ROBOT=<robot-id>` (see
  `docs/security/RUNBOOK_ROBOTS.md`).
- The page lists robots and users. It cannot add or delete robots: registration is `scripts/robots-admin.sh`. The account
  form creates or resets an Operator or Viewer account through `scripts/bootstrap-admin.sh` (ADR 0076). Admin accounts
  stay with `make bootstrap-admin` in a terminal.
- The site name is read-only. The page controls one site, from `SIM_SITE_ID` or `--site-id` (default `paris-01`).
- The users list shows the e-mail address of each account. Blur it before any screenshot.

## IAM actions the SSO role needs

Read actions for the page:

- `sts:GetCallerIdentity`
- `cognito-idp:ListUsers` and `cognito-idp:ListUsersInGroup` on the user pool of the stack
- `dynamodb:Query` on the fleet table of the stack

Actions of the account form, which runs `scripts/bootstrap-admin.sh`. They are the same actions `make bootstrap-admin`
already needs, so no permission is added:

- `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminUserGlobalSignOut` and `AdminAddUserToGroup`
  on the user pool of the stack

Actions that `make demo-start`, `make demo` and `make sim` already need, through the scripts:

- `lambda:ListEventSourceMappings`, `lambda:GetEventSourceMapping` and `lambda:UpdateEventSourceMapping` for the
  ingest consumer
- `lambda:InvokeFunction` on the robots function, for `sim-provision`
- read access to the Terraform state, for `terraform output -json`; `terraform output` does not lock

The page never runs `terraform apply` or `terraform destroy`. It writes to Cognito only through the account form, for
Operator and Viewer accounts, and it writes to no DynamoDB resource.

If the page shows **The AWS session lacks the permission ...**, the message names the missing action. Add that read to the
permission set in IAM Identity Center. This is a console change made by the operator, not by this repository.

## Messages and what to do

| Message code        | Meaning                                             | Action                                                     |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `NO_SESSION`        | The SSO session expired or is missing               | `aws sso login` in a terminal, then retry                  |
| `PERMISSION_DENIED` | The session lacks an action                         | Add the action named in the message (above)                |
| `AWS_UNAVAILABLE`   | AWS did not answer in time, or throttled            | Retry in a moment                                          |
| `STACK_UNAVAILABLE` | The stack outputs cannot be read                    | Deploy the stack, then retry                               |
| `CONSUMER_FAILED`   | The consumer could not be enabled or disabled       | Check the session, then retry                              |
| `PROVISION_FAILED`  | The simulated kits could not be registered          | Read the page log (below)                                  |
| `SIM_FAILED`        | The simulators did not take their lock in time      | Read the simulator log (below)                             |
| `STOP_TIMEOUT`      | The simulators did not stop within the grace period | Check the processes on this machine, then `make demo-stop` |
| `IN_PROGRESS`       | A Start or a Stop is already running                | Wait for it to finish                                      |

The page never shows a tool's output. The details are in the private logs, in the state directory
(`~/.local/state/fleet/demo-ui/` by default):

- `demo-ui.log`: the steps and their codes. It never holds a token.
- `sim.log`: the output of the simulators.

Both files are mode 600 and their directory is mode 700. Do not copy them into a ticket without reading them first.

## Stop and clean up

1. Click **Stop** on the page, or run `make demo-stop`.
2. Stop the page itself with Ctrl-C in its terminal. The page holds no state of its own.
3. Check the consumer with `scripts/demo-consumer.sh status`; it must report disabled.
