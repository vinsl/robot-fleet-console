# ADR 0071 — Local demo control server on 127.0.0.1, with the operator's SSO session

- Status: accepted; amended by ADR 0076 (the page writes to Cognito for Operator and Viewer accounts)
- Date: 2026-11-04
- Requirements: none in SPEC (operator tooling, bonus P in `docs/ROADMAP.md`); SEC rules of `docs/security/CHECKLIST.md`
- Implemented in: `agent/src/fleet_agent/demo_ui/`, `agent/tests/demo_ui/`, `scripts/demo.sh`, `scripts/links.sh`, `Makefile`
  (`demo`, `links`, `demo-ui`), `docs/security/RUNBOOK_DEMO.md`, `docs/security/THREAT_MODEL.md` (T64 to T69, R101, R102)

## Context

Before the demo, the operator starts the simulated fleet, enables the ingest consumer, reads the console link, lists the
Cognito accounts and the robots, and stops everything afterwards. Today that is five terminal commands, and the Start
and Stop steps run local scripts: `scripts/sim.sh` keeps its lock and its processes on the machine, and the robot kits
live under `~/.fleet/robots/`, which no Lambda can read. The page must also stay usable when the stack is stopped
(consumer disabled), so the controls cannot depend on the live API being up.

The deadline and the budget leave no room for a new internet-facing surface. Every new route on the deployed console is
reachable from the internet and needs an IAM role that can reach Cognito and the simulators.

## Decision

The demo control is a local process: `python -m fleet_agent.demo_ui`, a Python 3.12 standard-library server
(`ThreadingHTTPServer`) that listens on `127.0.0.1` only. It runs with the operator's own SSO session, through the `aws`
and `terraform` CLIs that the other scripts already use. It adds no dependency, no resource and no route to the deployed
stack, so it costs nothing in AWS.

- The page is one `index.html` with one `app.js` and one `app.css`, served from a fixed list of three names. No framework,
  no build step. Its strings are English, with a small French table selected by the browser language.
- Every request passes a Host check (`127.0.0.1:PORT` or `localhost:PORT`). Every POST also passes an Origin check and a
  `Content-Type: application/json` check, then a bearer token of 256 bits. The token is printed once in the start URL
  fragment (`#token=...`), on standard error only, so it never reaches a log file, a Referer or the process list.
- The server refuses any `--host` other than the loopback address at start-up.
- Start and Stop call the scripts the operator already runs (`demo-consumer.sh`, `sim-provision.sh`, `sim.sh`,
  `sim-stop.sh`). Stop runs the simulator stop and then disables the consumer, always, like `make demo-stop`.
- Users and robots are read with the SSO role: `cognito-idp list-users` and `list-users-in-group`, and one
  `dynamodb query` on the fleet table. The page writes to Cognito only through `scripts/bootstrap-admin.sh`, for Operator and Viewer accounts (ADR 0076).
  It never writes to DynamoDB, and never reads a kit.
- The page does not run `terraform apply` or `destroy`; it runs `terraform output -json` only.
- The tool lives outside `docs/design/DESIGN.md`. DESIGN.md governs the console, and this page is a local operator tool. It
  uses plain text, an icon and a colour for each state, so no state is shown by colour alone.

Deviations from the first design, all made while building it:

- **`errors.py`.** The stable error codes (`NO_SESSION`, `PERMISSION_DENIED`, `STOP_TIMEOUT`, and so on) live in their own
  module. The module maps each AWS CLI failure to a code and a fixed message, so no tool output reaches the browser.
- **A stop preempts a start.** The first design refused a second command while one ran (HTTP 409). The built controller
  lets a stop cancel a running start at its next step boundary, then runs the stop steps. A start that is still waiting for
  the lock is therefore never left running after the operator pressed Stop. The 409 remains for a second request of the
  same kind.
- **The lock probe reads `/proc/locks`.** The first design planned `flock -n` on the lock file. A probe that takes the
  lock would make a simulator starting at the same moment refuse to run. The probe matches the lock file by device and
  inode in `/proc/locks` instead, in both `scripts/demo.sh` and the Python controller. It needs Linux, which is the only
  platform the simulator runs on.

## Alternatives considered

| Option                                                        | Pros                                                             | Cons                                                                                                                                                                                                                                                                              | Why not                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Admin page in the deployed console, with an admin-only Lambda | Reachable from any browser, reuses the console login and the API | Start and Stop must run local scripts and local kits that no Lambda can reach; a new internet-facing route; an IAM role able to list Cognito users and enable the event source mapping; infra PRs and the CI deploy; the page would depend on the live stack it is meant to start | Adds a privileged, internet-facing surface for a single operator, and cannot do the local steps                                     |
| Node and the TypeScript toolchain for the local server        | Shares the console's tooling                                     | A build step; shares no code with the simulator and the scripts it drives                                                                                                                                                                                                         | Python already runs the simulator and the stack checks, so the server joins the same mypy, ruff and coverage gates with no new tool |
| Users and robots through the deployed API with a user JWT     | One data path, the same rules as the console                     | The tool would need an MFA login and would store tokens                                                                                                                                                                                                                           | The SSO role already reads the same data, with no token store                                                                       |

## Consequences

- Easier: no new AWS resource and no infra change; the page is covered by the same gates as the agent (mypy strict, ruff,
  pytest with the 80 % coverage target); Start and Stop keep the cost guard (consumer disabled) that the Makefile
  already has.
- Harder: the page works only on the operator's machine, and only with an SSO session. A Codespace needs VS Code port
  forwarding with visibility Private (never Public); see `docs/security/RUNBOOK_DEMO.md`.
- Security: the threats and their controls are rows T64 to T69 of `docs/security/THREAT_MODEL.md`; the checks are in
  `docs/security/CHECKLIST.md`. A same-user process can read `~/.aws` whatever this page does (R102). The page shows
  operator e-mails on 127.0.0.1 only, so screenshots must blur them.
- Cost: 0 USD of infrastructure. The reads are control-plane calls and one DynamoDB query per refresh.
- Multi-site later: the site is a parameter of every call and is checked against the configured site. Choosing sites from
  the page is a bonus in `docs/ROADMAP.md`, and needs the enrolment of ADR 0072 for real robots.
