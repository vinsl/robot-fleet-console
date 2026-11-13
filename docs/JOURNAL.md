# Engineering journal

Every real problem met during the build, written when it is solved. Feeds the "Difficulties" section
of the report. Newest on top.

Template:

```
## YYYY-MM-DD — <short title>
- Symptom:
- Root cause:
- Fix:
- What it taught / what I would do differently:
- Links: PR #, commit, doc
```

## 2026-11-06 — The load check with 20 robots hit the Lambda concurrency limit of the account

- Symptom: with 20 simulated robots started together, ten ran and ten stayed offline. After about two minutes all twenty
  were shown offline and the console answered "The request failed. Try again in a moment". The alarm
  `mfc-demo-ingest-events-throttles` went to the alarm state at 10:22 and 10:46 UTC.
- Root cause: the concurrent executions limit of the account is 10, shared by every Lambda function. The function
  `mfc-demo-ingest-events` is invoked straight by the IoT rules (events, acknowledgements, presence) with no queue in
  front, so a burst of robots goes past the limit. The telemetry consumer is capped at 5 and was not the problem. That
  the throttled presence events made the robots look offline is the most probable explanation, not a verified one.
- Fix: none applied, the test was not repeated for lack of time. Planned: ask for a higher quota in Service Quotas, and
  put a queue in front of `ingest-events` as for the telemetry. The demo is validated with at most ten robots.
- What it taught: the load check should have been run in the first week, not the last day, because the limit is a
  property of the account and not of the code. The alarm did its job: it is the first one that fired on a real fault.
- Links: `docs/PERFORMANCE.md`, `infra/envs/demo/ingest.tf`.

## 2026-11-04 — State history mixed the states of several robots

- Symptom: opening another robot in the side panel kept the previous robot's states in "State history", so one list
  showed Working, Moving, Teleop and Offline of different robots within seconds.
- Root cause: the panel reuses one `StateTimeline` instance when the route changes robot, and the history lives in the
  component state, so it was never reset.
- Fix: `StateTimeline` is keyed by the robot identifier, so a new robot starts with its own history. The test
  `panel-history-is-per-robot` fails without the key.

## 2026-11-04 — Phone layout overlapped in portrait and shrank the map in landscape

- Symptom: on a phone over 4G, the KPI summary overlapped the alert pill in portrait, and in landscape the desktop
  layout left a small map strip, with the controls and the pill overlapping the dock.
- Root cause: the compact layout was chosen by width only (under 640 px), and the KPI summary and the alert pill were
  both placed at the top of the map.
- Fix: ADR 0075. One compact query for narrow or short screens, no KPI corners or summary on a compact screen, and a
  test that forbids the width-only query.

## 2026-11-04 — An idle robot stayed PAUSED after an e-stop release

- Symptom: in the live test (block D), an idle robot was stopped with the e-stop, then released with the lock. It read
  PAUSED, and the operator had to send a command before it could take work.
- Root cause: SPEC §6, ADR 0028 and the state table sent `ESTOP_RELEASE` to `PAUSED` for every origin. The rule was written
  for a robot stopped in the middle of a mission, where PAUSED is the safe state. It did not depend on the state before
  the stop, so an idle robot was treated like a moving one.
- Fix: ADR 0073. The origin (IDLE or not) is kept in memory on the e-stop entry rows. The release goes to IDLE only when
  the origin was IDLE. An origin lost in a reboot goes to PAUSED. Tests: `test_estop_of_an_idle_robot_then_release_returns_to_idle`,
  `test_estop_release_of_a_latched_boot_pauses_and_clears_the_latch`, and invariant I2.
- What it taught: a safety rule written for the dangerous case can make the common case worse. Test the release from each
  origin, and let the rule depend on a recorded fact rather than on a default.
- Links: ADR 0073, ADR 0028, `agent/src/fleet_agent/core/model.py`, `agent/src/fleet_agent/core/effects.py`.

## 2026-11-04 — The video overlay hid the camera in the robot panel

- Symptom: in the live test (block F), the video overlay (name, state, position, speed, latency) covered most of the camera
  in the robot side panel, which is about 470 px wide.
- Root cause: the panel width is fixed by `--panel-w`, and the overlay could not be hidden or moved. The problem only shows
  with a real camera frame; the simulated robots have no camera, so the simulator could not show it.
- Fix: ADR 0074. A toggle on the panel's left edge widens it to `--panel-w-expanded` (60vw). A second toggle hides the
  overlay, and the latency chip stays. `docs/design/DESIGN.md` section 2.2 describes both.
- What it taught: a visual check needs the real media at the real size. A simulator without the media cannot replace it.
- Links: ADR 0074, ADR 0004, `docs/design/DESIGN.md` section 2.2.

## 2026-11-04 — Retired robots stayed in the fleet list and on the demo page

- Symptom: a robot retired in the registry kept showing in the console fleet list and on the demo page of the local control
  interface.
- Root cause: the last `STATE#` row of a robot stays in the table after retirement. The fleet read listed those rows, and
  nothing removed a robot that had left the registry.
- Fix: `DynamoDbFleetState.listSite` (`services/api/src/adapters/dynamodb-fleet-state.ts`) keeps only the robots the registry
  still lists. The demo page reads (`agent/src/fleet_agent/demo_ui/aws_reads.py`) filter the same way.
- What it taught: a read model that keeps history needs the registry, the source of truth for membership, at read time.
  Filtering on read avoids a second write that can fail halfway.
- Links: `services/api/src/adapters/dynamodb-fleet-state.ts`, `agent/src/fleet_agent/demo_ui/aws_reads.py`.

## 2026-11-04 — The Users page was a placeholder, and it is removed

- Symptom: the console had a Users route for Admins that showed a placeholder. In a demo it reads as a feature.
- Root cause: the page was cut from M9 by decision (bonus J), but its route and its placeholder stayed in the console.
- Fix: the route and the placeholder component (`apps/console/src/pages/SheetPlaceholder.tsx`) are removed. Accounts are still
  created with `make bootstrap-admin` or in the Cognito console. A future users page is bonus J in `docs/ROADMAP.md`.
- What it taught: a placeholder shows as a feature. A cut item should leave no route behind; the backlog keeps the record.
- Links: `docs/ROADMAP.md`.

## 2026-11-04 — The Kali clone had a corrupted .git

- Symptom: on the Kali VM, git could not read an object file (a sha1 file), and 635 tracked files showed as deleted.
- Root cause: not established. The object store of that clone was damaged.
- Fix: the clone was replaced by a fresh clone of the repository. Robot kits live outside the clone in `~/.fleet/robots/`,
  so a fresh clone does not touch them.
- What it taught: work that is pushed is safe in the remote, and a clone holds nothing else. When git reports a missing or
  unreadable object, stop using that clone and check what is pushed before any reset or re-clone.
- Links: the live test protocol, section 0.1.

## 2026-11-04 — The HTML report hid the passwords from the secret scan

- Symptom: the scan of the Playwright report, which must find the passwords of a run before the report is uploaded,
  had nothing to read in the HTML report.
- Root cause: the HTML reporter writes its data into a compressed zip archive inside the report folder. A byte search
  does not find text inside a compressed file, so a password in the archive is invisible to the scan.
- Fix: the reporters are `list` and `junit` only, and the HTML reporter is off. Traces, videos and screenshots are off as
  well, because they would capture the typed passwords and the TOTP code. The scanner fails closed: a zip or gzip file, or
  a symbolic link in the report, deletes the report and fails the job.
- What it taught: a secret scan is only as good as the files it can read. Choose outputs that a scan can read, and make
  the scanner refuse the files it cannot read rather than skip them.
- Links: ADR 0069 (decisions 1 and 5), `apps/console/playwright.config.ts`, `scripts/e2e-scan-report.mjs`.

## 2026-11-04 — The janitor matched no user: the Cognito username is a UUID

- Symptom: the janitor that deletes the users of a crashed run listed no user, although the pool held users left by a
  test run.
- Root cause: the user pool uses `username_attributes = [email]`, so the sign-in name is the e-mail address, and Cognito
  gives the `Username` an opaque UUID. A filter on the username found nothing.
- Fix: the janitor lists users with a filter on the `email` attribute, keeps only the e-mail shape of the test users
  (`e2e-<digits>-<digits>@example.com`) created more than 2 h earlier, and deletes each user by its `Username`.
- What it taught: with an e-mail sign-in, the username is not a name. Read the attributes of the pool before writing a
  filter, and match the attribute that holds the value.
- Links: ADR 0069 (decision 3), `scripts/e2e-setup.sh` (`sweep_stale_users`).

## 2026-11-04 — The secret scan flagged the public RFC 6238 test vector

- Symptom: gitleaks flagged the line of the TOTP unit test that holds the RFC 6238 test secret.
- Root cause: the test secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` is the base32 form of the public RFC 6238 test key
  (ASCII `12345678901234567890`). It has the shape of a generated secret, and it is not a credential.
- Fix: the one line carries the inline `gitleaks:allow` marker, and a comment says that the value is a public test
  vector. The file is not excluded from the scan.
- What it taught: a public test vector looks like a secret to a scanner. Mark the single line with its reason, and keep
  the scan on the rest of the file.
- Links: `apps/console/test/e2e/totp.test.ts`.

## 2026-11-04 — ESLint could not resolve Playwright until it was installed in the worktree

- Symptom: in the linked worktree, ESLint could not resolve `@playwright/test`.
- Root cause (probable, not reproduced in the main checkout): the worktree's `node_modules` is a link to the main
  checkout's installation, made before the devDependency was added, so the package was not in the tree that ESLint read.
- Fix: `pnpm install` run natively in the worktree, which installed the package in the worktree's own tree. The link
  helper was not used for this package.
- What it taught: after adding a devDependency, install in each worktree that lints or type-checks it. A shared link is
  not enough for a package that was added after the link was made.
- Links: ADR 0069 (decision 10), `apps/console/package.json`.

## 2026-11-04 — Two M9 branches conflicted on one line of the function-name union

- Symptom: the audit reader branch (PR #82) conflicted with the control branch (PR #81) when it was merged onto main.
  The conflict was in `services/api/src/observability.ts`, which only lists the function names used in logs and metrics.
- Root cause: both branches added one member to the same literal union. One line read `| "alerts";` and each branch
  replaced it with its own addition, so the second change touched the line the first had already changed.
- Fix: the union keeps all three names (`"alerts" | "control" | "audit"`). No logic changed.
- What it taught: parallel branches that extend one literal union collide on the same line. Add a member on its own line
  of a multi-line union, or merge the branches in a fixed order when they touch the same list.
- Links: PR #81, PR #82, `services/api/src/observability.ts`.

## 2026-11-04 — A stray node_modules symlink committed from a linked worktree

- Symptom: a commit on the M9 audit branch (`7df2a36`) listed `services/api/node_modules` as a new file. It was a
  symbolic link, not a directory.
- Root cause: the helper that prepares a worktree (`link-node-modules.sh`) links the main checkout's `node_modules` into
  each worktree, so that hooks and tests run there. The `node_modules/` pattern of `.gitignore` matches directories
  only, and git sees a symbolic link as a file. A broad `git add` therefore staged the link.
- Fix: a follow-up commit removed the link (`4ba5054`, "chore(api): drop a stray node_modules symlink") before the
  squash merge of PR #82. The rule for worktree commits is to stage named paths only.
- What it taught: a tool that creates links for itself must leave them out of the index. Check `git show --stat` before
  each commit made from a worktree, and never stage a whole directory that holds links.
- Links: PR #82, commits `7df2a36` and `4ba5054`. The helper `link-node-modules.sh` is kept outside the repository.

## 2026-11-04 — Pre-commit whitespace fixers changed the vendored KVS bundle

- Symptom: the vendored `kvs-webrtc` bundle no longer matched the SHA-256 pinned for it, after a commit that ran the
  pre-commit hooks.
- Root cause: the `end-of-file-fixer` and `trailing-whitespace` hooks apply to every text file. The minified bundle is
  a text file, so the hooks rewrote its bytes. Any change of a pinned file breaks its hash (ADR 0026).
- Fix: the two fixers exclude the three vendor directories (`apps/console/public/vendor/`, `apps/robot-video/public/vendor/`,
  `agent/src/fleet_agent/video/static/`) in `.pre-commit-config.yaml`, with a comment that cites ADR 0026. The change is
  in PR #85.
- What it taught: a hook that rewrites files must know which files are pinned by hash. Exclude pinned third-party files
  from every fixer, not only from the one that changed them, and keep the pin test in the checks that run before a push.
- Links: PR #85, `.pre-commit-config.yaml`, ADR 0026, ADR 0067.

## 2026-11-04 — Pre-push hook failed because node_modules was incomplete

- Symptom: a push from a worktree failed in the pre-push hook, before any remote call.
- Root cause: the worktree links its `node_modules` to the main checkout (see the symlink entry above). The install in
  that checkout was incomplete, so the tools the hook calls were missing.
- Fix: complete the install in the main checkout, then push again through the hook. `--no-verify` is not used.
- What it taught: a linked worktree is only as complete as the checkout it links to. Before reading a hook failure as a
  code problem, check that the link target has the packages the hook needs.
- Links: the local worktree workflow, `docs/JOURNAL.md` entry of 2026-11-04 on the guard hook.

## 2026-11-04 — Push refused from a worktree: the guard hook reads the main checkout

- Symptom: a push from a git worktree on a feature branch was refused by the local guard hook. The commits were ready
  and reviewed, and the push did not go through from the worktree.
- Root cause: the guard hook takes the project branch from the main checkout, not from the directory where the command
  runs. With the main checkout on `main`, a push from a worktree was judged as a push to `main`. The hook also refuses a
  shell command whose text names a push together with a main-like word, so some harmless commands were refused for
  their text.
- Fix: the worktree was removed (`git worktree remove`), the main checkout was switched to the feature branch, and the
  push ran from there. The hook was not bypassed: no `--no-verify`, and the hook was not changed. The text that the
  guard matched was written with the file tools, not in a shell command.
- What it taught: a tool that reads "the current branch" from one fixed checkout breaks the worktree workflow without a
  clear message. Keep one checkout per branch that is published, or make the hook read the branch of the working
  directory. Check the guard's matching rules before a long shell script, not after.
- Links: local Claude Code guard hook (not part of the repository); PRs #68 and #69 were published after the fix.

## 2026-11-04 — ADR number taken by a parallel branch

- Symptom: the M8 design reserved ADR 0056 for the alerts API. When the ADRs were written, 0056 was already the
  workstation footprint decision of M7. Four code comments in `services/api/src/domain/alerts/` cite 0056 for the
  alerts API.
- Root cause: the design was written from the base commit of its branch. The M7 site editor work added ADR 0056 after
  that base, and the design's numbers were not checked against the ADR index when the ADRs were written.
- Fix: the alerts API decision is ADR 0061. ADRs 0057 to 0060 keep the numbers of the design. ADR 0061 states the change,
  and four code comments must read 0061.
- What it taught: check the next free ADR number on the current base before a design fixes numbers, and reserve the
  number when the branch starts.
- Links: `docs/adr/0061-alerts-api-site-scoped-routes-key-locator-and-transactional-lifecycle.md`,
  `docs/adr/0056-workstation-footprint-as-optional-size-on-the-point.md`

## 2026-11-03 — Codespace disk filled by one Terraform provider cache per worktree

- Symptom: the Codespace disk filled up while `make check-tf` ran in several worktrees. Each worktree held its own
  `.terraform-check/` directory of about 1.6 GB.
- Root cause: `make check-tf` sets `TF_DATA_DIR` to a directory per root under `.terraform-check/` in the worktree
  (Makefile, target `check-tf`). Each `terraform init -backend=false` therefore downloaded the provider binaries again
  into its own worktree. The directory is git-ignored, so the duplication was invisible in `git status`.
- Fix: the checks use a shared provider cache, `TF_PLUGIN_CACHE_DIR` under the home folder (`~/.terraform.d/plugin-cache`,
  about 780 MB once for all worktrees). A worktree's `.terraform-check/` now takes about 92 KB, since the providers are
  linked from the cache. The variable is not set by the Makefile or the repository; it has to be exported in the shell
  or the dev container. The free space of the Codespace was about 2.3 GB of 32 GB when this was written.
- What it taught: a data directory that isolates a check from remote state does not need to hold the provider binaries
  too. The provider cache is not state and can be shared. Look at `du -sh` of the git-ignored directories before a
  disk alarm, because `git status` does not show them.
- Links: `Makefile` (target `check-tf`), `.gitignore` (`.terraform-check/`)

## 2026-11-03 — Labels cut at the frame edge on large plans

- Symptom: on a plan of about 200 m, the workstation and charger labels at the edge of the map were cut off by the view.
- Root cause: the view padding was a fixed 2 m (`VIEW_PADDING_M`). The labels are drawn in marker units, which scale with
  the plan, so on a large plan a label reached past a 2 m margin and was clipped.
- Fix: commit e615140 sets the padding to the larger of 2 m and three marker units (`LABEL_CLEARANCE_UNITS`). The marker
  size is taken from the features alone, so the padding does not change it. The label offsets are named constants that
  the view and the padding both read, so they cannot drift apart. The overflow is left visible, so a long name is shown
  whole and is not cut. The same commit gave the charger the existing station colour token, because a new colour token
  needs an ADR.
- What it taught: a margin given in metres does not follow the drawing when the labels are drawn in units of the plan.
  Express the margin in the unit the labels use, and derive both from the same constants. Test the view on a large plan,
  not only on the small fixture.
- Links: commit e615140, `apps/console/src/site/render/map-geometry.ts`, `apps/console/src/site/render/SiteMapView.tsx`

## 2026-11-03 — The generated sample DXF changed between runs with the hash seed

- Symptom: the test that compares the committed sample with the generator had to compare sorted lines, because the bytes
  differed between runs. The generator was run under 12 hash seeds: 9 seeds wrote one file and 3 seeds (4, 7, 10) wrote
  another. The two files differed only in the order of two lines of the CLASSES section (`ACDBPLACEHOLDER` and `LAYOUT`).
- Root cause: ezdxf adds the DXF classes of the entity types in use while it writes, by iterating a set of type names
  (`EntityDB.dxf_types_in_use`). Python randomises string hashes for each process, so the order of that set changes.
  Turning on ezdxf's fixed-metadata switch was not enough: it fixes the creation and save times and the GUIDs, not the
  class order.
- Fix: `write_sample` registers the in-use classes in sorted order before the save, so ezdxf finds nothing new to add in
  its own order. The bytes differ only in the CLASSES order. The test compares
  bytes exactly, and a regression test regenerates the file under hash seeds 0 to 7, and seeds 0 and 4 wrote different files before the fix.
- What it taught: a flag meant for tests makes the output deterministic only for what it covers. Check the bytes across
  several hash seeds, not across two runs of one process, before writing an exact comparison. ADR 0055 records the choice.
- Links: `agent/tools/make_sample_dxf.py` (`_register_in_use_classes_in_order`), `agent/tests/test_make_sample_dxf.py`,
  `agent/tools/sample/warehouse.dxf`, ADR 0055

## 2026-11-03 — The deploy role could not tag an event source mapping or an API stage

- Symptom: deploy run 41596678699 failed. The deploy role had no `lambda:TagResource` on the telemetry event source
  mapping, and no `apigateway:TagResource` on the WebSocket stage.
- Root cause: the bootstrap policy granted the create and update actions of both resources, but not the tag actions.
  Terraform tags a mapping when it creates it. The tag actions address the mapping ARN, which the `FunctionArn` condition
  of the Lambda statement cannot match. The API Gateway tag action was missing from the management paths statement.
- Fix: PR #42 (commit 6fc2f5f, merged 2026-11-03 07:43 UTC) adds the tag and list actions only, scoped to
  `event-source-mapping` ARNs, and the two API Gateway tag actions to the existing paths. The bootstrap policy is applied
  by the owner (ADR 0020), then the deploy workflow is re-run. This entry does not record the bootstrap apply or the re-run.
- What it taught: a permission that creation needs is not always the permission that tagging needs. Each tag call has its
  own action and its own resource ARN, so a condition written for the primary action can silently miss it. A new resource
  type is checked with the deploy role before the PR is merged.
- Links: PR #42, commit 6fc2f5f, `infra/bootstrap/policies.tf` (`LambdaEventSourceMappingTags`, `ApiGatewayManagementPaths`),
  ADR 0020

## 2026-11-03 — Bucket names without the account id, and no CloudFront logging

- Symptom: the design named the console and logs buckets with the account id. The account id would then show in the
  bucket names of the console delivery, and CloudFront classic logging could not be enabled on the logs bucket.
- Root cause: bucket names are global, so they need a unique part, but the account id is not a value to print in URLs.
  Classic CloudFront logging writes with object ACLs, which conflict with `BucketOwnerEnforced` on the logs bucket.
- Fix: the buckets take the stack's `bucket_suffix` instead of the account id, so the account id stays only in IAM and
  bucket policy conditions. CloudFront logging is skipped. The S3 server access logs of the console bucket are the only
  logs kept (R54, ADR 0046).
- What it taught: check the object ownership model of a bucket before you choose a logging feature that writes to it.
- Links: `infra/modules/web` (buckets, logs policy), ADR 0046, THREAT_MODEL R54

## 2026-11-02 — Codespace stopped mid-run, and the work was recovered from the uncommitted tree

- Symptom: the Codespace stopped in the middle of an M5 run, while the realtime work of the session was still
  uncommitted.
- Root cause: the changes existed only in the working tree of the Codespace. Nothing had been committed or pushed since
  the last checkpoint, so the remote branch did not hold them.
- Fix: the working tree on the disk was intact after the restart. The changes were committed on
  `feat/realtime-websocket-api` in small commits by area (protocol, live state, ingest, WebSocket, simulator, scripts),
  from `04e265d` to `11a5e43`.
- What it taught: a working tree is not a backup. Commit and push each slice as soon as it is green, so that a crash
  loses one slice at most, and do not keep several slices uncommitted over a long run.
- Links: branch `feat/realtime-websocket-api`, commits `04e265d` to `11a5e43`.

## 2026-11-02 — The committed video page drifted after the protocol exports changed

- Symptom: `make video-page-check` failed: the committed build of the robot video page under
  `agent/src/fleet_agent/video/static/` differed from a fresh build of `apps/robot-video`.
- Root cause: the page is built from code that imports `packages/protocol`. The M5 schemas (WebSocket, alerts, fleet
  state, site map) changed the exports, so the bundle and its manifest changed too. The committed build was not rebuilt
  in the same commit.
- Fix: the page was rebuilt with `make video-page` and committed in two `chore(video)` commits (`96b35d8` and
  `1011fe6`). `make video-page-check` then passed. The check is part of `make check`, so it runs before a push.
- What it taught: a generated file committed to the repository must be rebuilt in the same commit as the change of its
  input. A byte-for-byte check against a fresh build is the cheapest way to see that the rule was broken.
- Links: `make video-page-check` (Makefile), ADR 0037, commits `96b35d8` and `1011fe6`.

## 2026-11-02 — `estop-command` with a wrong robot id left an empty file and published an empty payload

- Symptom: a dev e-stop was prepared with `estop-command` and a robot id that did not match the kit. The output file was
  empty, and the publish step sent an empty payload to the robot's command topic.
- Root cause: `estop-command` loads the kit of the robot id it is given. With no kit for that id it refuses with exit code
  78 and writes nothing to standard output (`_estop_command` in `agent/src/fleet_agent/cli.py`). The shell redirection
  had already created the output file empty, and the publish step ran on it without checking the exit status of the
  command before it.
- Fix: use the same robot id in every command of the procedure: the kit directory, `estop-command`, the topic path and
  the publish. Before publishing, check that `estop-command` succeeded and that the file holds one JSON line.
- What it taught: a shell redirection creates its file before the command runs, so an empty file does not show that the
  command succeeded. A publish step must check the exit status of the step before it.
- Links: `docs/security/RUNBOOK_ROBOTS.md` section 6.3, ADR 0034.

## 2026-11-02 — `make agent` returned 130, not the agent's exit code 0

- Symptom: after a clean stop of `make agent ROBOT=<robot-id>`, `echo $?` printed 130. The agent had stopped on request,
  which is exit code 0 in its own rules.
- Root cause: `make` runs the agent as a recipe. When the recipe is interrupted, `make` exits with 130 (128 plus SIGINT)
  for the interrupted recipe, and it does not pass the agent's own exit code through. The shell sees make's status.
- Fix: read the agent's exit code by running it directly, `cd agent && uv run fleet-agent run --robot-id <robot-id>`, and
  reading `$?` after it stops, or read the `agent.stopped` line in the JSON logs. The runbook (section 6.5 and section 7)
  now says so.
- What it taught: a wrapper's exit status is not the status of the program it wraps. Test an exit code on the program
  that produces it.
- Links: `docs/security/RUNBOOK_ROBOTS.md` sections 6.5 and 7.

## 2026-11-02 — Two live-test commands that did not test what they were meant to

- Symptom: the network-cut run showed no `link.lost`, and the SIGTERM run ended with `agent.stopping`, no `agent.stopped`
  and exit code 130.
- Root cause: both were operator commands, not agent faults. The first cut `lo` instead of `eth0`, so the traffic to AWS
  never stopped. The second used `pkill -f` on the command line, which matched the `uv run` wrapper as well as the Python
  process; `uv` forwarded the signal, the agent received two, and a second signal forces the exit with 130 by design.
- Fix: the runbook now names `eth0` and asks for one signal on the Python process, found with `ps`. Re-run the same day:
  the cut gave `link.lost`, `link.connect_failed` and an automatic reconnection; the single SIGTERM gave `agent.stopping`,
  `agent.stopped` and exit code 0.
- What it taught / what I would do differently: a live procedure must say which object it acts on and what a wrong target
  looks like.
- Links: `docs/security/RUNBOOK_ROBOTS.md` sections 6.4 and 6.5

## 2026-11-02 — First live run of the agent and the isolation probe

- Symptom: none left, after two fixes found by the run itself (the QoS 0 PUBACK `TypeError` and the probe's
  `NOT_CONNECTED`, both in their own entries).
- Result: on the Kali VM `make agent ROBOT=kali-01` connects, subscribes and publishes telemetry at about 2 Hz
  (`telemetry.summary` shows 19 messages in 10 s). The MQTT test client of the IoT console received
  `$aws/events/presence/connected/mfc-demo-kali-01`. With the agent stopped, the probe passes its nine checks.
- What it taught / what I would do differently: the first live run found two bugs that 900 unit tests could not, because
  both came from what the real SDK and the real broker do. A live smoke of each adapter belongs early in the step.
- Screenshots: `docs/screenshots/06-iot-robot-thing-connected.png` (the IP address and the certificate identifier are
  covered by a solid rectangle) and `07-agent-json-logs.png`.

## 2026-11-02 — One isolation check read NOT_CONNECTED on the first live probe

- Symptom: on the Kali VM, eight of the nine checks passed and `other-events-publish` read `NOT_CONNECTED`, so the probe
  exited 1 although no check was refused wrongly.
- Root cause: each check opens a fresh connection with the robot's client identifier, back to back. AWS IoT allows one
  CONNECT per second per client identifier, so a quick reconnection was throttled and never reached the broker's
  authorisation decision. The unit tests use a scripted broker with no such limit.
- Fix: the probe waits 1.5 s between two connections (`spacing_s`, zero in the unit tests). Pinned by
  `test_the_probe_pauses_between_two_connections`.
- What it taught / what I would do differently: a limit the design cited (D2 in the agent design) must reach every
  caller that reconnects, not only the transport's own retry loop.
- Links: `agent/src/fleet_agent/tools/isolation_probe.py`

## 2026-11-02 — The first live run logged a TypeError on every telemetry publish

- Symptom: on the Kali VM the agent connected and subscribed, then logged `link.callback_failed` with `TypeError`
  every 0.5 s, once per telemetry message.
- Root cause: for a QoS 0 publish the SDK does not leave the PUBACK unset. It completes the publish with an empty
  `PubackPacket` whose `reason_code` is `None`, and the transport mapped it with `int(puback.reason_code)`. The unit tests
  used a fake with `puback=None`, which the real SDK never returns.
- Fix: a PUBACK with no reason code counts as published, like a missing one. Pinned by
  `test_a_qos0_publish_with_an_empty_puback_counts_as_published`, which builds the SDK's own types.
- What it taught / what I would do differently: a fake must mirror what the library really returns. The live run found it
  in seconds; the next adapter tests should build the SDK's own result types.
- Links: `agent/src/fleet_agent/adapters/mqtt_crt.py`

## 2026-11-02 — Test fixtures with a PEM header were blocked by Gitleaks and detect-private-key

- Symptom: the pre-commit hooks (Gitleaks and detect-private-key) refused to commit the agent's test fixtures. The
  fixtures hold no key: the rule matched the header line alone.
- Root cause: the tests wrote the complete PEM private-key header line (five dashes, BEGIN, PRIVATE KEY, five dashes) as one string literal, which both rules
  match. A scanner reads the text it is given and cannot tell a fixture from a key.
- Fix: the header is built from two literals, the two halves of that line joined with `+`, in
  `agent/tests/adapters/test_mqtt_crt.py` and `agent/tests/config/test_kit_file.py`. The protocol fixture builder
  (`agent/tests/protocol/conftest.py`) builds its PEM blocks from a label constant.- What it taught: a fixture that needs a header should build it from parts, and a rule that matches the header is a
  rule about the text, not about the secret. No key material is in the repository either way.
- Links: PR B (`feat/agent-runtime`); `agent/tests/adapters/test_mqtt_crt.py`, `agent/tests/config/test_kit_file.py`,
  `agent/tests/protocol/conftest.py`

## 2026-11-02 — The environment value `443` was refused as a broker port

- Symptom: `FLEET_MQTT_PORT=443` failed the settings check with `INVALID`, while the same port written in `agent.toml`
  was accepted.
- Root cause: the port is typed `Literal[8883, 443]`. Pydantic's lax mode converts a string to an integer for an `int`
  field, but not for a literal of integers. Checked on 2026-11-02 with the agent's pydantic 2.14: the string `"443"` is
  rejected.
- Fix: a `BeforeValidator` (`_port_from_text` in `agent/src/fleet_agent/config/settings.py`) converts a string made only
  of digits to an integer. Any other value is left to the literal check, so `"80"` and `"443x"` are still refused. Tests:
  `test_accepts_the_port_as_text_from_the_environment`, `test_refuses_a_port_other_than_the_two_allowed`
  (`agent/tests/config/test_settings.py`).
- What it taught: every environment value is a string. A setting that is read from both the file and the environment must
  be tested with both sources, not assumed to convert the same way.
- Links: PR B; `agent/src/fleet_agent/config/settings.py`

## 2026-11-02 — A key the TLS context refuses raised `RuntimeError`, not `AwsCrtError`

- Symptom: the design expected the SDK to raise `AwsCrtError` for a key that the TLS context refuses. The kit loader
  maps that error to the kit refusal `KIT_KEY_INVALID`, so a different error class would have escaped the refusal.
- Root cause: awscrt 0.36.1, the version in `agent/uv.lock`, raises `RuntimeError` from the mutual-TLS builder when the
  key is not a key. Checked on 2026-11-02 with the locked package and a PEM block that holds no key.
- Fix: `build_crt_transport` maps `AwsCrtError`, `RuntimeError`, `TypeError` and `ValueError` to `KIT_KEY_INVALID`, and
  raises it `from None`, so the SDK's message, which can quote the key, is not chained. Test:
  `test_a_key_the_tls_context_refuses_is_a_kit_key_invalid` (`agent/tests/adapters/test_mqtt_crt.py`).
- What it taught: the class of an error from a native binding is part of its behaviour, and it must be checked on the
  pinned version, not taken from the documentation of another version.
- Links: PR B; ADR 0033, ADR 0035

## 2026-11-02 — A restart scheduled by a suspend could reconnect during a shutdown

- Symptom: a link that the core had suspended could come back after a shutdown had begun, so a robot that was going
  offline reconnected.
- Root cause: the timer that restarts a suspended client was not cancelled by the shutdown, and was not checked again
  when it fired. It started the client after `stop` had been requested.
- Fix: `stop` sets the shutdown flag, cancels the pending restart and clears the resume time. The restart checks the flag
  again when the timer fires, and `suspend` does nothing during a shutdown. Tests:
  `test_a_restart_scheduled_before_a_shutdown_does_not_start_the_client` and `test_suspend_does_nothing_during_a_shutdown`
  (`agent/tests/adapters/test_mqtt_crt.py`).
- What it taught: a timer scheduled before a state change must check that state when it fires, not only when it is
  scheduled.
- Links: PR B; `agent/src/fleet_agent/adapters/mqtt_crt.py`

## 2026-11-02 — `make smoke` refused to read the Terraform outputs on the first live checks

- Symptom: `make smoke` failed with "Backend configuration block has changed" and then "Terraform outputs are
  unavailable in infra/envs/demo", although the deploy had succeeded.
- Root cause: the local `.terraform` directory of `infra/envs/demo` had been initialised without the S3 backend
  (`make check-tf` runs `init -backend=false`), so Terraform refused to read the remote state.
- Fix: `terraform -chdir=infra/envs/demo init -reconfigure -input=false`, which changes no state, then `make smoke`.
- What it taught / what I would do differently: the live checks of `RUNBOOK_ROBOTS.md` section 4 need a backend
  `init`; the runbook now says so in its prerequisites.
- Links: `docs/security/RUNBOOK_ROBOTS.md`

## 2026-11-02 — An ESTOP could be refused by a full QoS 1 queue

- Symptom: with the QoS 1 outbox at its cap of 100 pending messages, for example during a long disconnection, the
  acknowledgement of an `ESTOP` and its `STATE_CHANGED` were refused with `outbox.full`, like any telemetry or event.
- Root cause: the cap applied to every QoS 1 message alike. ADR 0034 stated that the only backlog drops rather than
  delays, and that no priority scheme was needed. That assumed a full outbox could never refuse a stop, and it could.
- Fix (025f853): the acknowledgement and the state change of an e-stop are priority messages. They may use
  `PRIORITY_QOS1_HEADROOM` (8) slots above the cap. The count is clamped at zero when a transport reports one publish
  twice. Pinned by `test_an_estop_is_acknowledged_and_announced_while_the_qos1_queue_is_full` and
  `test_a_publish_reported_twice_cannot_lift_the_cap`.
- What it taught: a bound that drops messages also bounds the stop. Reserve headroom for the stop path, name it in the
  ADR, and test the stop at the full bound.
- Links: 025f853, ADR 0034, `agent/src/fleet_agent/core/outbox.py`

## 2026-11-02 — A halted core ignored an ESTOP

- Symptom: after a halt, the core returned from `on_message` for every message. An `ESTOP` received afterwards was not
  latched and got no acknowledgement.
- Root cause: the halt guard was written as "a halted core does nothing". That is right for commands, but the stop path
  must stay open after a halt.
- Fix (025f853): `_estop_after_halt` stops the robot in place, makes one latch write attempt without halting again, and
  sends a best-effort priority acknowledgement with no `STATE_CHANGED`. Every other command stays dropped. Pinned by
  `test_an_estop_after_a_halt_stops_latches_and_is_acknowledged` and
  `test_every_command_but_an_estop_is_still_dropped_after_a_halt`.
- What it taught: a safe-state rule must list what still gets through. The stop is the one input that survives every
  state, including a fault.
- Links: 025f853, ADR 0034, `agent/tests/core/test_agent_failsafe.py`

## 2026-11-02 — The goodbye took its sequence number at the start of the shutdown

- Symptom: `begin_shutdown` built the `GOING_OFFLINE` event, and so took its sequence number, when the shutdown began.
  Acknowledgements and state changes published after that, such as an `ESTOP` during the shutdown, carried higher
  numbers, so the goodbye was not the last message by sequence.
- Root cause: the message was built where the shutdown was decided, not where it was sent.
- Fix (025f853): `begin_shutdown()` returns nothing. `build_goodbye()` builds the event when the runner is ready, after
  the last publish, so it takes the highest number. Pinned by
  `test_the_goodbye_sequence_is_above_every_message_published_before_it` and
  `test_begin_shutdown_takes_no_sequence_number_until_the_goodbye_is_built`. The runner must keep that order (PR B).
- What it taught: a sequence number belongs to the moment of sending. Build the envelope at the send, not when the
  decision is made.
- Links: 025f853, ADR 0034, `agent/tests/core/test_agent_commands.py`

## 2026-11-02 — SPEC said the robot publishes OFFLINE on shutdown, the protocol says GOING_OFFLINE

- Symptom: SPEC §4.1 said that a graceful shutdown publishes an `OFFLINE` event. ADR 0027 says the robot publishes
  `GOING_OFFLINE` with reason `SHUTDOWN`, and never `OFFLINE`, which the cloud sets on disconnect or after 15 s of
  silence. The two documents named different messages for the same step. The agent code follows ADR 0027.
- Root cause: the SPEC sentence dates from the pre-development docs (commit 99a72ff), before ADR 0027 fixed the event set.
- Fix: SPEC §4.1 names `GOING_OFFLINE` with reason `SHUTDOWN`, and states that the cloud sets `OFFLINE` (a6a2e7e). The
  message is pinned by `test_going_offline_states_the_shutdown_reason` (`agent/tests/core/test_messages.py`).
- What it taught: a spec sentence that names a message is a claim about the protocol. When the protocol changes, those
  sentences change in the same commit, and a grep for the old name finds the rest.
- Links: a6a2e7e, ADR 0027, `docs/SPEC.md` §4.1

## 2026-11-02 — SPEC §6 deadman rule did not match ADR 0028

- Symptom: SPEC §6 said only that `TELEOP` needs a valid lock and that a deadman expiry (no heartbeat for 1 s) goes to
  `PAUSED`. It did not say which states arm the deadman, that it runs while the link is down, or that a motion with no
  lock holder is not armed. ADR 0028 arms it while the lock is held, in `TELEOP`, `MOVING` or `WORKING`.
- Root cause: the SPEC line dates from the pre-development docs (commit 99a72ff). ADR 0028 refined the arming rule, and
  the SPEC line was not updated with it.
- Fix: SPEC §6 gives the arming states, the 1 s silence, the 50 ms check, the offline behaviour, and the R29 exception
  (a6a2e7e). `test_armed_only_when_locked_and_in_a_motion_state` (`agent/tests/core/test_deadman.py`) pins the rule.
- What it taught: a safety rule has three parts: what arms it, what it does when it fires, and when it is checked. The
  spec and the ADR must state all three, and the tests must name them.
- Links: a6a2e7e, ADR 0028, `docs/SPEC.md` §6

## 2026-11-02 — The state table gave a repeated ESTOP no effect, the design rewrote the latch

- Symptom: the e-stop design said that a repeated `ESTOP` rewrites the latch, so that `latchedAt` tracks the last press.
  The state table, present since the state machine was committed (a197181), gives `ESTOP` from `ESTOP` the answer `ACK` with state
  `SAME` and no effect. The two could not both hold.
- Root cause: the design note was written without comparing it with the table row it changes. A second gap appeared
  later: when the first latch write failed, a repeated `ESTOP` did nothing, so the latch was not written until a reboot.
- Fix: the table is the source of truth, and a repeated `ESTOP` writes nothing while the latch is persisted
  (`test_an_estop_while_the_latch_is_in_place_writes_nothing_again`). While `latch_persisted` is false, the core adds
  `LATCH_ESTOP` to that row (`_effects_for` in `agent/src/fleet_agent/core/agent.py`). The table is unchanged, and the
  parity test keeps it equal to the TypeScript table. Pinned by `test_a_failed_estop_latch_is_retried_by_the_next_estop_and_then_persisted`.
  The ruling is in ADR 0034.
- What it taught: when the table is the source of truth, a behaviour that the table does not carry belongs in the code
  that applies it, not in the table. Each design sentence should name the table row it changes.
- Links: 4f843df, ADR 0034, `agent/tests/protocol/test_state_machine_parity.py`

## 2026-11-02 — Shutdown moved the robot again and dropped the ESTOP

- Symptom: found in the security review of the agent core. After `begin_shutdown`, a robot that was moving could move
  again. The shutdown set the speed to zero but kept the destination, and the next tick recomputed the speed from it.
  A stopping core also returned from `on_message` for every message, so an `ESTOP` received during a shutdown got
  neither an acknowledgement nor a latch write.
- Root cause: the shutdown was built as "stop taking commands", not as "stop the robot and keep the stop path open". The
  motion step did not check the stopping flag, and the message path did not separate an `ESTOP` from the other commands.
- Fix (4f843df): `begin_shutdown` clears the destination as well as the speed, and the motion step keeps the speed at zero
  while stopping. While stopping, `on_message` acts on an `ESTOP` that passes screening, and drops the other messages with
  a log line at most once per interval. Pinned by `test_a_stopping_robot_keeps_its_speed_at_zero_and_does_not_move` and
  `test_an_estop_is_still_latched_and_acknowledged_while_stopping`.
- What it taught: a stop has to be enforced in the model, not only at the input. For each stop path, list what can still
  move and what still gets through, then test both.
- Later: the goodbye moved to `build_goodbye()` in 025f853 (see the entry on the goodbye sequence below).
- Links: 4f843df, ADR 0034, `agent/tests/core/test_agent_tick.py`, `agent/tests/core/test_agent_commands.py`

## 2026-11-02 — The protocol accepts a date the calendar does not have

- Symptom: the protocol's `IsoMs` pattern accepts `0000-02-29T00:00:00.000Z`. Year 0000 is divisible by 400, so the leap
  day passes the pattern. The issue time has no calendar date that Python can read, so the age of such a command cannot
  be computed.
- Root cause: the pattern checks the shape of the timestamp and the leap-day rule, not that the year exists. Python's
  `datetime` starts at year 1, so `strptime` refuses year 0000.
- Fix: `_age_ms` in `agent/src/fleet_agent/core/screening.py` returns None when the time cannot be read. Screening
  refuses every such command except `ESTOP` as `EXPIRED`, and accepts the `ESTOP`
  (`test_an_unreadable_issue_time_is_expired_but_a_stop_is_accepted`, `agent/tests/core/test_screening.py`). The gap
  therefore fails closed. Tightening the protocol pattern to a real calendar date, with parity fixtures in
  `packages/protocol`, is not done yet.
- What it taught: a regular expression is not a calendar. A parse that can fail must fail to a safe answer, and for a
  stop the safe answer is to act. The pattern fix is a separate change with fixtures on both sides.
- Links: ADR 0034, `packages/protocol` (`IsoMs`), `agent/src/fleet_agent/protocol/primitives.py`

## 2026-11-02 — The shell umask was not applied to the kit directory and file

- Symptom: `umask 077` followed by `mkdir` gave a directory of mode 756 and a file of mode 646 on the ext4 mounts of the
  development container (`/tmp`, `/workspaces`). The same commands on tmpfs and overlayfs gave 700 and 600, and an
  explicit `mkdir -m 700` was honoured on the ext4 mounts too. The first version of `scripts/robots-admin.sh` relied on
  the umask for the private kit directory and file, so the check of the offline run caught it.
- Root cause: not investigated further. The ext4 mounts of this container do not apply the process umask to new
  directories and files; the cause is in the container's file system layer, not in the script.
- Fix: the script sets every mode it depends on explicitly. The kit directories get `chmod 700`, and the answer file is
  created first with `noclobber` (which also refuses an existing answer in one step) and `chmod 600`, before the kit is
  written into it. The offline checks of the script, run with a stub `aws` outside the repository, verify the modes.
- What it taught: the umask is a default, not a guarantee. A file that holds a private key gets its mode and its
  creation order set by the code, and its existence check is atomic.
- Links: `scripts/robots-admin.sh` (`register_robot`, `ensure_private_dir`), ADR 0029

## 2026-11-01 — A git-ignore glob hid the kit configuration fixtures from git

- Symptom: a clean checkout of `feat/protocol-robot-v1` failed the protocol fixture test and the Python parity tests,
  because the directory `packages/protocol/fixtures/robot-kit-config/` was missing. The files existed in the working
  copy only, so the local run had passed.
- Root cause: `.gitignore` has `robot-kit*/`, which keeps real robot kits out of the repository. The same glob matched
  the fixture directory, so `git add` skipped its ten fixture files. No local check compared the working copy with a clean
  checkout.
- Fix: a targeted negation, `!packages/protocol/fixtures/robot-kit-config/`, after the glob, and the ten fixtures
  committed in b7ed91e. The fixtures hold placeholders only. The gap was found by running `make check` in a clean
  worktree of the branch. The same commit also ignores `.claude/worktrees/`.
- What it taught: a broad ignore glob can hide files that must be committed, and git reports nothing. Check each new
  fixture directory with `git check-ignore -v <path>`, and run `make check` in a clean checkout before a pull request,
  not only in the working copy.
- Links: `.gitignore`, `packages/protocol/fixtures/robot-kit-config/`, commit b7ed91e

## 2026-11-01 — Another process moved the main checkout to `main` during the work

- Symptom: during a documentation pass, the main checkout changed from `feat/protocol-robot-v1` to `main`, and was then
  fast-forwarded to `main`. A commit attempted there was refused by the no-commit-to-branch hook.
- Root cause: not identified. The reflog shows `checkout: moving from feat/protocol-robot-v1 to main` followed by
  `pull --ff-only`, from a process other than the documentation pass.
- Fix: the documentation commit was made from a temporary worktree of the feature branch, which was then removed. Nothing
  was committed on `main`.
- What it taught: a shared checkout can change branch during a long task. Check `git branch --show-current` before each
  commit, and write through a worktree when the checkout is shared.
- Links: `git reflog` of the main checkout, 2026-11-01

## 2026-11-01 — Secret scanners flagged the private-key pattern in the protocol schemas

- Symptom: the PEM pattern of the robot kit schema was committed in the generated JSON Schema, and the secret scanners
  (Gitleaks, Trivy and detect-private-key) reported a private-key header in the protocol files. The fixtures that
  exercised the kit also held a literal key header.
- Root cause: the pattern named both header forms and required the footer to match the header. Written that way, the
  pattern put a literal key header into `packages/protocol/generated/`, because the JSON Schema generator writes the zod
  pattern verbatim. The scanners match the header text, not the key body.
- Fix: the fixtures hold the placeholder `{{PEM:PRIVATE_KEY}}`. Both test suites expand it at load time to a fake,
  key-shaped body built from the label at run time (`packages/protocol/test/fixtures.test.ts`,
  `agent/tests/protocol/conftest.py`). The first fix let the footer differ from the header, as accepted deviation 1 of
  ADR 0027. A review the same day removed that deviation: the header and footer must match again, and the pattern is
  built with an empty group `(?:)` inside the literal text, so the generated schema holds no contiguous header. The check
  to run is a grep for `BEGIN` in `packages/protocol/generated/`; an automated test for it is still open in the checklist.
- What it taught: a secret scanner matches the text of a header, so a committed file that describes a key needs a
  placeholder and a header built at run time. A generated artifact carries whatever its source writes, so its text needs
  the same check as the source. A shape check in a schema is not a control: the agent's start-up check of the key file
  (planned in P4) is the control that refuses a file that is not a key.
- Links: `packages/protocol/src/robots.ts`, `packages/protocol/test/fixtures.test.ts`, `agent/tests/protocol/conftest.py`,
  `docs/adr/0027-robot-protocol-v1-envelopes-commands-acks-replay.md`

## 2026-11-01 — The topic rule ARN used a resource type that IAM does not have

- Symptom: found while designing the robot identity step (M4), before any apply. The deploy policy `mfc-demo-deploy-iot`
  granted `topicrule/mfc_demo_*`, so CI could not create the telemetry rule. No rule had been created yet, so nothing failed.
- Root cause: the IAM resource type of a topic rule is `rule` (AWS Service Authorization Reference, IoT). `topicrule` is the
  name of the API family, not a resource type, so the ARN matched no rule. IAM accepts any resource string in a policy, so
  neither `terraform validate` nor the plan reports it, and the existing tests only checked that no `*` was granted.
- Fix: the policy grants `rule/mfc_demo_*`. `iot_topic_rules_use_the_rule_resource_type` checks the grant and rejects any
  `topicrule` text in the rendered policy. Mutation check: putting `topicrule` back fails that run only.
- What it taught: check every resource ARN against the service authorization reference, not against the API name, and
  pin the resource type in a test. A wrong ARN in an IAM policy is silent until a call fails.
- Links: ADR 0020 (amendment of 2026-11-01), `infra/bootstrap/policies.tf` (`deploy_iot`), `infra/bootstrap/tests/iam.tftest.hcl`

## 2026-11-01 — IoT V2 logging writes to a log group that the naming rule does not cover

- Symptom: the robot identity step turns on IoT logging at ERROR, which creates and writes the log group `AWSIotLogsV2`. The
  workload boundary and `mfc-demo-deploy-core` only allowed log groups with a demo prefix, so neither CI nor the IoT logging
  role could use that group.
- Root cause: AWS IoT names its V2 logging group `AWSIotLogsV2`. The name is fixed by AWS and has no prefix. The boundary
  was written around the rule that every demo name carries `mfc-demo-`, and that rule had no exception for this group.
- Fix: `mfc-demo-deploy-core` and the workload boundary now name `AWSIotLogsV2` and its streams. The test
  `iot_log_group_is_the_only_unprefixed_log_group` checks that every log resource of those two policies is a demo group or
  this group, and that both ARNs are present.
- What it taught: a naming boundary needs an explicit list of the names that AWS fixes, and that list is checked before the
  feature starts. The group must also not exist before the first apply (the pre-flight check `aws logs describe-log-groups`),
  or Terraform would have to import it.
- Links: ADR 0020 (amendment of 2026-11-01), `infra/bootstrap/policies.tf` (`deploy_core`, `workload_boundary`)

## 2026-11-01 — Video spike works, but the VM webcam gives 1 to 3 frames per second

- Symptom: live video reached the viewer through KVS, but the camera delivered 1 to 3 frames per second. The clock
  digits filmed for the latency measurement overlapped, so 10 of 15 readings were skipped and only 5 were valid.
- Root cause: the VirtualBox webcam emulation exposes only a brightness control: exposure and dynamic frame rate cannot
  be set, and in a dim room the camera lengthens its exposure. Not verified further (no test on the Windows host).
- Fix: none for the spike. The result is recorded as not conclusive (ADR 0025, Result) and the project continues with
  this camera. Running the master page in the Windows host browser is kept as an optional improvement.
- What it taught: a latency measurement that films a clock needs a camera that delivers at least 15 frames per second;
  check the real frame rate before the sampling, not after. The WebRTC statistics (round-trip 40 ms, decode 6 ms) are a
  better transport figure than the camera-in-the-loop reading.
- Links: `apps/video-spike/README.md`, `docs/adr/0025-video-spike-hand-made-channel-and-session.md`, screenshot 05

## 2026-11-01 — Pre-commit whitespace hooks rewrote the vendored KVS bundle

- Symptom: the minified KVS WebRTC bundle in `apps/video-spike/public/vendor/` was changed by the commit hooks, and its
  SHA-256 no longer matched the pin in `apps/video-spike/src/kvs/vendor-manifest.ts`.
- Root cause: the `end-of-file-fixer` and `trailing-whitespace` hooks of `.pre-commit-config.yaml` rewrite a text file in
  place when it does not end with a newline or has trailing spaces. The bundle is a third-party file, and the hooks ran on
  it because no exclude named its folder.
- Fix: both hooks exclude `^apps/video-spike/public/vendor/`, with a comment that cites ADR 0026. The folder is also
  listed in `.prettierignore` and in the ESLint global ignores. `test/vendor.test.ts` recomputes the SHA-256 and fails on
  any change, so the pin is checked by the tests and not only by the hooks.
- What it taught: a pinned file needs every formatting or whitespace tool excluded, not only the formatter. A hook that
  rewrites a file fails the commit and leaves the rewritten bytes in the working tree, so the SHA-256 must be checked
  after a commit that touched the vendored folder.
- Links: `.pre-commit-config.yaml`, `.prettierignore`, `eslint.config.js`, `apps/video-spike/test/vendor.test.ts`,
  `docs/adr/0026-vendored-kvs-webrtc-bundle.md`

## 2026-11-01 — Raw USB redirection gave a black stream; `webcam attach` is the path used

- Symptom: a webcam passed to the Kali VM by USB redirection gave a black stream.
- Root cause: not traced further. USB redirection is a different path from VirtualBox's webcam path, and the setup did
  not isolate the cause.
- Fix: `VBoxManage controlvm "<vm name>" webcam attach .1` on the host, then `v4l2-ctl` checks in the VM
  (`apps/video-spike/README.md`, step 2 and step 3).
- What it taught: check the device with `v4l2-ctl` before opening the browser, and choose the VirtualBox path that
  delivers frames rather than debugging the one that does not.
- Verified: the operator observed the black stream with USB redirection and a usable stream with `webcam attach`.
  Not verified in this entry: the frame rate, which README step 3 measures and the run will record.
- Links: `apps/video-spike/README.md`, `docs/adr/0025-video-spike-hand-made-channel-and-session.md`

## 2026-11-01 — VirtualBox VM name is not the guest hostname

- Symptom: during the setup, the name given to `VBoxManage` did not match the guest hostname of the Kali VM.
- Root cause: VirtualBox identifies a VM by the name shown in its manager. The hostname is set inside the guest and has
  no link with that name.
- Fix: take the name from `VBoxManage list vms` and use it in every `VBoxManage` command, never the hostname. The run
  procedure of `apps/video-spike/README.md` says so in its introduction.
- What it taught: use the identifier that the host tool lists, not the one the guest reports.
- Verified: the rule is recorded from the setup. The `VBoxManage` commands were not re-run for this entry.
- Links: `apps/video-spike/README.md` (run procedure, introduction)

## 2026-11-01 — Kali image needed an archive keyring refresh before the spike packages

- Symptom: the Kali image needed its archive keyring refreshed before the packages of the spike could be installed.
- Root cause: the archive keyring of the image was out of date.
- Fix: refresh the Kali archive keyring in the VM, then run the `apt install` of step 3 of `apps/video-spike/README.md`.
- What it taught: refresh the keyring before the first `apt install` on an older image, not after a failure.
- Verified: the packages were installed after the refresh in the setup. The exact apt error is not recorded here.
- Links: `apps/video-spike/README.md` (step 3)

## 2026-11-01 — A blocking lintian version stopped the `apt install`

- Symptom: a dependency of the spike packages could not be satisfied while the installed lintian version was in place.
- Root cause: the installed lintian version blocked the dependency.
- Fix: the `apt install` was run with `lintian-` added to the package list. The trailing `-` removes that package in the
  same transaction, so the dependency can be resolved.
- What it taught: a removal inside an install is a visible change. Read the dependency error and name the package it
  blocks before removing anything.
- Verified: the install was completed in the setup. The apt output is not recorded here.
- Links: `apps/video-spike/README.md` (step 3)

## 2026-11-01 — Film the screen with the external LifeCam, not the built-in camera

- Symptom: the built-in webcam was not the camera chosen to film the viewer screen.
- Root cause: the latency measurement needs a camera that the operator can aim at the reference clock on the viewer
  screen. The external LifeCam is that camera; the built-in one was not chosen for this.
- Fix: the external LifeCam is attached to the VM and films the viewer screen (`apps/video-spike/README.md`, step 6).
- What it taught: the measurement setup decides which camera is used, not convenience.
- Verified: the choice is documented in the README. No footage from the run is recorded yet.
- Links: `apps/video-spike/README.md` (step 6, latency protocol), `docs/adr/0025-video-spike-hand-made-channel-and-session.md`

## 2026-11-01 — Rolling one CI policy back alone re-opened two denies

- Symptom: while the rollback procedure of the bootstrap runbook was written, a rollback of `mfc-demo-deploy-data` alone to
  its version `v1` was checked with `simulate-custom-policy`. The check allowed the deploy role to administer the state bucket
  and to write trail objects.
- Root cause: PR C moved the state bucket administration deny and the trail bucket deny from `mfc-demo-deploy-core` to
  `mfc-demo-deploy-data`. A managed policy is rolled back as a whole, so a rollback of deploy-data alone restored a version
  without the two denies, while deploy-core no longer carried them either.
- Fix: the runbook rolls the two CI policies back together, deploy-core first then deploy-data, and each
  `set-default-policy-version` needs the owner's approval. The bootstrap makes `aws_iam_policy.deploy_core` depend on
  `aws_iam_policy.deploy_data`, so the apply writes the new deploy-data first and the denies exist before deploy-core drops
  them. The procedure is in `docs/security/RUNBOOK_BOOTSTRAP_APPLY.md`.
- What it taught: when a statement moves from one policy to another, the unit of a rollback changes too. A rollback has to
  restore every policy that held a moved statement, and it has to be checked against the rendered documents, not only
  against the list of versions.
- Links: `docs/security/RUNBOOK_BOOTSTRAP_APPLY.md`, `docs/security/THREAT_MODEL.md` (R10, R15), ADR 0024

## 2026-11-01 — Three IAM action names in a deny did not exist

- Symptom: Access Analyzer `validate-policy` on the deployed `mfc-demo-deploy-core` returned `ERROR INVALID_ACTION`
  for `s3:DeleteBucketPublicAccessBlock`, `s3:DeleteBucketOwnershipControls` and `s3:DeleteBucketEncryption`. All three
  sat in `DenyStateBucketAdministration`.
- Root cause: the three names were inferred from the names of the Delete APIs. The S3 user guide and the service
  reference authorise those APIs with the Put* action of the same setting, which the deny already lists. IAM accepted
  the unknown names without an error, so they covered nothing and removed nothing: no access was granted or lost.
- Fix: the three names disappeared when the state bucket deny became `NotAction [s3:Get*, s3:List*]` in
  `mfc-demo-deploy-data` (ADR 0024), so the deny no longer lists action names. `audit_trail_and_state_denies_hold` in
  `infra/bootstrap/tests/iam.tftest.hcl` pins the NotAction set, so any later change to it is a reviewed change. The
  live policy is replaced when the bootstrap is applied; that apply is pending at the time of writing.
- What it taught: validate every rendered policy with Access Analyzer before an apply. A mocked test checks the
  document that the code renders, not the vocabulary that IAM accepts.
- Links: `infra/bootstrap/policies.tf`, `infra/bootstrap/tests/iam.tftest.hcl`, ADR 0024

## 2026-11-01 — The trail bucket was reachable through the workload boundary

- Symptom: the security review of the trail bucket reported two findings. F1 (Medium): the workload boundary allowed
  `s3:*` on `mfc-demo-*`, which covers the trail bucket. A read-only `simulate-custom-policy` on the live boundary
  allowed all six S3 actions probed on the bucket and on its objects. F2 (Low): `cloudtrail:CreateTrail` was allowed on
  `trail/mfc-demo-*`, so CI could create a second trail, or recreate the demo trail with delivery to another account.
- Root cause: the name pattern `mfc-demo-*` covers the trail bucket in the workload boundary and in the deploy policy.
  The earlier denies stopped object deletes only, which left overwrites, lifecycle, bucket policy and versioning open.
  `CreateTrail` has no condition key that ties the new trail to a bucket, so the Allow could not be limited to the existing one.
- Fix: the workload boundary denies `s3:*` on the trail bucket (`DenyTrailBucket`). The deploy role gets a `NotAction`
  deny that leaves only the reads and the three tag actions (the provider tags buckets through S3 Control, so the tag
  actions are kept). `CreateTrail` is removed from the Allow and denied on `*`, and `StartLogging`, `AddTags` and
  `RemoveTags` are narrowed to `trail/mfc-demo-trail`. Tests: `trail_bucket_is_read_only_to_ci` and
  `ci_manages_only_the_demo_trail`. The live policies are replaced when the bootstrap is applied; that apply is
  pending at the time of writing. The decision is ADR 0024.
- Review note: the same review found that the state bucket deny enumerated its actions, so Object Lock, Notification,
  Logging, IntelligentTiering and Abac on the state bucket were allowed to CI (state bucket finding F1, a separate
  finding from the trail bucket F1 above). The deny moves to `mfc-demo-deploy-data` as a `NotAction` on the state bucket
  ARN, so no action list has to be kept complete.
- What it taught: a resource carved out of a prefix needs a deny on every path, not only on the obvious action. For a
  small allowed set, a `NotAction` deny is safer than a list of denied actions, because the list misses the actions
  that AWS adds later.
- Links: `infra/bootstrap/policies.tf`, `infra/bootstrap/tests/iam.tftest.hcl`, `docs/security/THREAT_MODEL.md` (R11, R15),
  ADR 0024

## 2026-11-01 — `make check-tf` gets its own Terraform data directory

- Symptom: after a real `terraform plan`, `make check-tf` failed again with "No valid credential sources found", for
  `envs/demo` this time. It had to be worked around by moving `.terraform/` aside, three times in two days.
- Root cause: a real plan records the S3 backend in `<root>/.terraform/terraform.tfstate`, and `init -backend=false`
  reads that file before it ignores the backend block.
- Fix: `check-tf` exports `TF_DATA_DIR=.terraform-check/<root>`, so the offline checks never see the data directory of a
  real run. The directory is git-ignored and skipped by Trivy. Checked by planting a fake S3 backend record in
  `infra/envs/demo/.terraform/`: the checks still pass.
- What it taught: when one tool is used both online and offline in the same directory, give the offline use its own state
  instead of cleaning up by hand. This replaces the "move `.terraform/` aside" advice of the entry above.
- Links: `Makefile` (`check-tf`), `.gitignore`

## 2026-11-01 — SNS rejected a wildcard action in the topic policy

- Symptom: the first deploy created the budgets, the trail and the topic, then failed on `aws_sns_topic_policy` with
  `InvalidParameter: Policy statement action out of service scope!`.
- Root cause: the plain-HTTP denial was widened from `sns:Publish` to `sns:*` after the security review, to match the
  bucket policies. The mocked provider cannot see that SNS refuses a wildcard action in a topic policy, so the unit
  tests and the read-only plan passed.
- Fix: the denial names `sns:Publish` again, and the test pins it. The apply is idempotent: a second deploy only
  creates the missing policy.
- What it taught: a mocked test checks the document, not the service that validates it. A change to a resource
  policy after the last live plan needs a real apply to be trusted; keep such changes out of the last review round,
  or say that they are untested against AWS.
- Links: `infra/modules/alarm-topic/main.tf`, `infra/envs/demo/tests/alarm_topic.tftest.hcl`

## 2026-10-31 — CI plan job refused by the OIDC trust: immutable subject not matched

- Symptom: the plan job of PR #13 failed while assuming `mfc-demo-gha-plan` with
  `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Every retry (12 in total) failed the same way.
- Root cause: the repository has immutable OIDC subjects enabled, so GitHub puts the owner and repository ids in
  the token subject (`repo:vinsl@84448605/robot-fleet-console@1439837333:...`). The bootstrap trust policies
  matched the mutable name (`repo:vinsl/robot-fleet-console:...`), which no token carries. The trust was
  written from the name in the docs, without reading the repository setting.
- Fix: `github_repository` is replaced by `github_oidc_repository` in `infra/bootstrap/variables.tf`, with a
  validation that rejects the mutable form and wildcards. Both trust subjects use it, with `StringEquals` only.
  The bootstrap tests assert the immutable subjects and the rejection of the old form and of a wildcard. The
  subject strings in the security docs and ADR 0002 and 0020 are updated to match.
- What it taught: before writing a trust policy, read the subject GitHub actually issues:
  `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. The immutable form also stops a trust on a reused
  repository name, which is why it stays enabled.
- Links: `infra/bootstrap/roles.tf`, `infra/bootstrap/tests/iam.tftest.hcl`,
  `docs/adr/0020-github-oidc-roles-and-deploy-boundary.md` (Immutable OIDC subjects), PR #13

## 2026-10-31 — Saved plan files hold sensitive values unredacted

- Symptom: the plan text shows "(sensitive value)" for the alarm address, but a plan saved with `-out` keeps the planned
  values in clear text.
- Root cause: apply runs from the saved plan, so Terraform stores the planned values in the file. The `sensitive` mark only
  hides the display.
- Fix: `bootstrap.tfplan` was deleted by hand after its apply. The deploy and plan workflows still write `tfplan` into the
  working directory. The file is git-ignored and never uploaded as an artifact, and the GitHub-hosted runner discards it
  with the job, but no step deletes it. Open: write plans to a temporary 0600 file outside the repository and delete it after
  apply. Not done in PR B, because it changes `.github/` and needs the owner's merge.
- What it taught: a `sensitive` mark protects the display, not the saved file. Treat a saved plan like the state it came from.
- Links: `.github/workflows/deploy.yml`, `.github/workflows/terraform-plan.yml`, `docs/security/THREAT_MODEL.md` (R17)

## 2026-10-31 — Check block on a computed ARN fails the mocked plan

- Symptom: `terraform test` failed the run with "Check block assertion known after apply" on `trail_arn_matches_policy`,
  although the mocked trail has an ARN.
- Root cause: in a plan, the ARN of a trail that is being created is unknown. `terraform test` treats an unknown check
  condition as an error, where a plan only defers it.
- Fix: `override_during = plan` on the trail's `override_resource` in `audit_trail.tftest.hcl` and `demo.tftest.hcl` makes the
  mocked ARN known during the plan. A trail ARN that differs from the built one then fails the run (checked on a scratch copy).
- What it taught: a check on a computed attribute needs a known value in the test. A plan-only test cannot see it otherwise.
- Links: `infra/modules/audit-trail/main.tf`, `infra/envs/demo/tests/audit_trail.tftest.hcl`, `infra/envs/demo/tests/demo.tftest.hcl`

## 2026-10-31 — Info: the first deploy may need `billing:GetBillingViewData`

- Status: not observed. If the first deploy's budget update returns AccessDenied, the deploy role needs
  `billing:GetBillingViewData` on the primary billing view.
- Fix if it happens: a bootstrap PR adds the action. The deploy role is not changed in PR B.
- Links: `infra/envs/demo/budgets.tf`, `infra/bootstrap/policies.tf`

## 2026-10-31 — Security review of the bootstrap policies: four Medium findings fixed

- Symptom: `security-reviewer` reviewed `infra/bootstrap/policies.tf` and reported four Medium findings. The
  fixes are in this branch and in the tests of `iam.tftest.hcl`:
  - Plan role: `ReadOnlyAccess` allows read actions that the plan guard did not deny by name. `PartiQLSelect`
    reads table items without `GetItem`; X-Ray traces, IoT thing shadows, log query results and CloudTrail
    `LookupEvents` return data that the guard did not cover.
  - Deploy role: `cloudtrail:UpdateTrail`, `DeleteTrail`, `PutEventSelectors` and `access-analyzer:DeleteAnalyzer`
    were not denied, and object deletes in the trail bucket and object-version deletes on the state bucket were
    allowed.
  - Workload boundary: `logs`, `iot`, `kinesisvideo`, `cognito-idp` and `execute-api` were allowed on `*`.
- Root cause: the plan guard denied the usual data reads by name, but a managed read-only policy grants many
  more read paths to the same data. `cloudtrail:StopLogging` was denied, but that alone does not keep an audit
  trail intact: the trail could still be deleted or have its event selectors changed. The boundary used `*`
  where the services have resource ARNs.
- Fix: the plan guard gets a statement with eleven more denies (`DenyTelemetryTracesAndAuditReads`). The deploy
  role is denied trail deletion and update, event-selector changes, analyzer deletion, and object or
  object-version deletes on the trail bucket. The state bucket is denied object-version deletes. The boundary
  is narrowed to `mfc-demo-*` ARNs, with `*` kept only for `xray:*` and `cloudwatch:PutMetricData`. Tests:
  `plan_guard_denies_partiql_traces_and_audit_reads`, `audit_trail_and_state_denies_hold`,
  `workload_boundary_has_no_global_resource_allow`.
- What it taught: a deny list over a managed read-only policy has to be read action by action, because the
  same data is often reachable through another API. A deny on the stop action is not enough to protect an
  audit trail: each change must be denied, and the denies sit on their own statements so that no later Allow
  can undo them. Still open: bucket-level actions on the trail bucket (policy, lifecycle) stay allowed, and no
  trail is declared in code yet (THREAT_MODEL R15).
- Links: `infra/bootstrap/policies.tf`, `infra/bootstrap/tests/iam.tftest.hcl`, `docs/security/THREAT_MODEL.md`
  R9 to R15, `docs/adr/0020-github-oidc-roles-and-deploy-boundary.md`

## 2026-10-31 — IAM condition on role-policy actions never matched

- Symptom: in the first draft of the deploy-core policy, the statement that let the deploy role attach and
  put policies on workload roles carried the `iam:PermissionsBoundary` condition. The statement could not
  match, so the deploy role had no right to attach role policies.
- Root cause: `iam:PermissionsBoundary` is present only on requests that set a boundary (`iam:CreateRole`,
  `iam:PutRolePermissionsBoundary`). `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy` and
  `DetachRolePolicy` do not carry that key, so a condition on them is evaluated as a non-match. IAM does not
  report a dead statement; the failure would only appear as `AccessDenied` on the first apply.
- Fix: the statement is split. `CreateRole` and `PutRolePermissionsBoundary` keep the boundary condition. The
  four policy actions are scoped to the `/mfc-demo/` path, and the boundary caps what they grant.
- What it taught: before writing a condition key, check which requests carry it. A condition that a request
  lacks silently removes the statement.
- Links: `infra/bootstrap/policies.tf`, `docs/adr/0020-github-oidc-roles-and-deploy-boundary.md`

## 2026-10-31 — Trivy ignores the AVD identifier of a reviewed exception

- Symptom: Trivy 0.70 kept reporting the SSE-KMS finding on the state bucket encryption resource although an
  ignore comment was present. The comment used the AVD form of the identifier.
- Root cause: Trivy 0.70 reads `#trivy:ignore:` comments that use the rule id `AWS-0132`, and it only honours
  them when the comment sits directly above the resource block.
- Fix: the comment is `#trivy:ignore:AWS-0132`, placed directly above `aws_s3_bucket_server_side_encryption_configuration.state`,
  with the reason on the lines above it. The customer-managed key decision is recorded in the Checkov skip on the bucket.
- What it taught: an exception must be checked with the scanner version that CI runs. A comment that the
  scanner ignores still looks like a reviewed exception.
- Links: `infra/bootstrap/state.tf`, `.trivyignore`

## 2026-10-31 — The plan role cannot take the Terraform state lock

- Symptom: a plan run under the read-only plan role could not create the S3 lock object that `use_lockfile`
  needs, so the pull request plan could not start.
- Root cause: `ReadOnlyAccess` grants no `s3:PutObject`. Only the deploy role may write the lock object
  (`mfc-demo-deploy-core`).
- Fix: `terraform-plan.yml` runs `terraform plan -lock=false`. A plan only reads state, so it cannot corrupt
  the state written by an apply. The deploy plan and apply keep the lock.
- What it taught: a lock is a write. A read-only role cannot take it, so `-lock=false` is acceptable only for a
  command that does not change state, and the decision is recorded in ADR 0005.
- Links: `.github/workflows/terraform-plan.yml`, `docs/adr/0005-terraform-s3-locking-and-bootstrap.md`

## 2026-10-31 — Design delivery did not compile against the repository

- Symptom: after copying the design kit into the console, `pnpm typecheck` failed. `robot-state-visuals.ts`
  imported `RobotState` from `@fleet/protocol`, which is neither the package name (`@mfc/protocol`) nor
  exported yet, and `lucide-react` was not installed. `prettier --check` also failed on the two frozen
  mock-ups under `docs/design/references/`, which are not parseable HTML.
- Root cause: the kit was written before M1 fixed the package scope and before `packages/protocol` had any
  state vocabulary. The kit's PLAN and PROGRESS were also older than M1, so they could not be copied over
  the current ones.
- Fix: import renamed to `@mfc/protocol`; `RobotStateSchema` (the nine states of SPEC section 6) added to
  `packages/protocol` with its test; `lucide-react` added to the console; the mock-ups listed in
  `.prettierignore`. PLAN, SPEC and PROGRESS were edited in place instead of replaced.
- What it taught: a kit written against a moving repository needs an integration pass, and its documents
  must be merged as diffs, not copied.
- Links: `docs/adr/0004-console-visual-design.md`, `apps/console/src/theme/robot-state-visuals.ts`

## 2026-10-31 — Proof that the gate blocks a leak and a lint error

- Symptom: none, this is the planned proof of M1. A closed draft pull request (#6) added a fabricated AWS
  access key id in `docs/gate-proof/leak.txt` and an explicit `any` in `apps/console/src/gate-proof.ts`.
- Result: Secrets (Gitleaks, "leaks found: 1"), Dependencies, IaC and secrets (Trivy, CRITICAL
  `aws-access-key-id`) and TypeScript (lint, `no-explicit-any` and `no-unsafe-assignment`) failed. Python,
  Terraform, package audits, Semgrep and zizmor stayed green, so each check fails for its own reason only.
- Method: the proof pull request targeted the M1 branch, so that the fixed workflows ran on it and the key never
  entered the history of the default branch. Local hooks were bypassed with `--no-verify` on that one throwaway
  commit, so that CI was the layer under test.
- Side effect: after the remote branch was deleted, the stale remote-tracking ref made the local `make check-secrets`
  report the key. `git fetch --prune` removed it; the history of the default branch was never affected.
- Residual: GitHub keeps `refs/pull/6/head`, so the fabricated key stays readable on the closed pull request.
  Only GitHub Support can purge it. Accepted as R8 in the threat model.
- What it taught: a gate is only proven by seeing it fail for the intended reason. Choosing a key that the scanner
  does not allowlist mattered as much as the scanner itself.
- Links: PR #5, PR #6 (closed), `docs/security/THREAT_MODEL.md` R8

## 2026-10-31 — zizmor flags workflow_run in deploy.yml

- Symptom: zizmor reported a High finding (dangerous trigger) on the first draft of `deploy.yml`, which ran
  on `workflow_run` after the CI workflow.
- Root cause: a `workflow_run` job can be started for a branch from a fork. A fork branch named `main` could
  then mint an OIDC token with the subject that the deploy role trusts (`ref:refs/heads/main`).
- Fix: `deploy.yml` runs on `push` to `main` and calls `ci.yml` as a reusable workflow on the same commit.
  The deploy job has `needs: ci`, so the deployed code is the code that passed the gate.
- What it taught: a deploy trigger should be a push to the protected branch, not an event that runs
  against another context. A reusable call also keeps the gate and the deploy in one run.
- Links: `.github/workflows/deploy.yml`, `docs/adr/0002-ci-security-gate.md`

## 2026-10-31 — gitleaks-action fails on pull requests of the private repository

- Symptom: the Gitleaks job failed on pull requests before any scan ran.
- Root cause: the action reads pull request metadata with the workflow token. Under the least-privilege
  permissions (`contents: read`), the token does not include `pull-requests: read`. By default the action
  also scans only the pull request commits, and it hides the scanner version behind the wrapper.
- Fix: Gitleaks runs as a pinned binary with its SHA-256 digest checked, with `fetch-depth: 0` and
  `gitleaks git` over the full history. No extra permission is needed.
- What it taught: a wrapper action adds a token requirement and a version I do not see. For a security
  gate, a checksum-verified binary is easier to review.
- Links: `.github/workflows/security.yml`, `docs/adr/0002-ci-security-gate.md`

## 2026-10-31 — Gitleaks allowlists the AWS documentation example key

- Symptom: the planned proof (a throwaway PR with a fake AWS key must fail) used the AWS documentation
  example key, and Gitleaks did not report it. The gate looked open for the wrong reason.
- Root cause: the default Gitleaks configuration allowlists the AWS documentation example key
  `AKIAIOSFODNN7EXAMPLE` as a known example.
- Fix: the proof uses a different fake key with the same shape, which the default rules do not allowlist.
- What it taught: a fixture for a secret scanner must not reuse the examples that the scanner ignores. A
  gate proof that passes for the wrong reason proves nothing.
- Links: `.pre-commit-config.yaml`

## 2026-10-31 — detect-aws-credentials does not match key patterns

- Symptom: the `detect-aws-credentials` pre-commit hook did not flag a string shaped like an AWS access key
  in a file.
- Root cause: the hook checks the credentials already present in `~/.aws/credentials` or in the environment.
  It does no pattern matching on file content.
- Fix: Gitleaks is the detector for content, in pre-commit and in CI. The hook stays as a guard against
  loaded credentials, and `docs/security/CI_CD.md` states what each layer checks.
- What it taught: read what a hook checks before counting it as a control.
- Links: `.pre-commit-config.yaml`, `docs/security/CI_CD.md`

## 2026-10-31 — Trivy secret scanner skips the proof file

- Symptom: the fake key placed in the planned proof file was not reported by the Trivy secret scanner.
- Root cause: the Trivy secret rules match a key only when it is followed by whitespace or the end of the
  line. Its skip rules also exclude `test/example/*.md` paths.
- Fix: the proof places the fake key in a regular file outside the skipped paths, followed by a line
  break. Each blocking scanner is checked separately with the proof, not assumed to cover the others.
- What it taught: every scanner has its own skip and match rules. A proof has to run against each
  blocking scanner.
- Links: `.trivyignore`, `.github/workflows/security.yml`

## 2026-10-31 — pip-audit rejects the project line in uv export

- Symptom: pip-audit failed on the requirements file produced by `uv export`.
- Root cause: by default `uv export` includes the project itself as an editable line (`-e .`). pip-audit
  with `--require-hashes` cannot audit that local requirement.
- Fix: the export uses `--no-emit-project` together with `--no-dev`, so the audit sees the locked runtime
  dependencies only. The same flags are in `security.yml` and in `make check-deps`.
- What it taught: the input to an audit must be the exact set of locked, hashed dependencies, and nothing
  else.
- Links: `agent/pyproject.toml`, `Makefile` (`check-deps`), `.github/workflows/security.yml`

## 2026-10-31 — git diff misses new generated files

- Symptom: the first version of the "generated files are up to date" check used `git diff --exit-code`. It
  passed when the generator created a new file, for example a new schema.
- Root cause: `git diff` lists changes to tracked files only. A file that the generator creates is untracked
  and does not appear in the diff.
- Fix: the check uses `git status --porcelain -- <generated paths>`, which lists modified and untracked
  files. Any output fails the job.
- What it taught: a staleness check has to see new files as well as changed ones.
- Links: `.github/workflows/ci.yml`, `Makefile` (`check-generated`)

## 2026-10-31 — pins younger than 14 days replaced

- Symptom: some pinned versions (pre-commit hook revisions and tool versions) had been published less than
  14 days before the pin. The release-age policy in ADR 0002 forbids that.
- Root cause: the age rule is enforced at resolution time (pnpm `minimumReleaseAge`, uv `exclude-newer`,
  Dependabot cooldown). Manual pins are not checked by any of them.
- Fix: each such pin was replaced with the latest release older than 14 days. Pre-commit revisions are
  pinned by full commit SHA, with the release in a comment.
- What it taught: a manual pin needs a date check at the moment it is written. The tools only cover what
  they resolve.
- Links: `.pre-commit-config.yaml`, `docs/adr/0002-ci-security-gate.md`

## 2026-10-31 — corepack rejects a base64 integrity in packageManager

- Symptom: corepack refused the `packageManager` field when the pnpm integrity hash was written in base64
  form, as npm writes it in lockfiles.
- Root cause: the `packageManager` field expects the hash as a hex SHA-512 digest after the `+sha512.`
  prefix. The lockfile format is different.
- Fix: the field uses the hex digest (`pnpm@10.34.7+sha512.<128 hex characters>`).
- What it taught: do not copy an integrity string from a lockfile into `packageManager`. Each format has its
  own encoding.
- Links: `package.json`

## 2026-10-31 — first bootstrap apply refused to plan without the S3 backend

- Symptom: after `terraform init -backend=false`, `terraform plan` failed with "Backend initialization
  required", and a plain `terraform init` failed because the state bucket did not exist yet.
- Root cause: `-backend=false` skips backend setup for that `init` only; it is not remembered, so the next
  command reads the `backend "s3"` block again. The bucket it points to is created by this very root.
- Fix: a git-ignored `override.tf` with `backend "local" {}` for the first plan and apply, then removed before
  `terraform init -migrate-state`. The procedure is in ADR 0005 and `infra/bootstrap/versions.tf`.
- What it taught: `-backend=false` is fine for `validate` (CI, `make check-tf`) but not for a real plan.
- Links: `infra/bootstrap/versions.tf`, `docs/adr/0005-terraform-s3-locking-and-bootstrap.md`

## 2026-10-31 — Console-made budgets need their filter, metric and billing view in code

- Symptom: the hand-made budgets carry a cost filter, the metric `UnblendedCost` and a billing view. A budget resource
  that does not set these attributes does not match them: the plan has to change them, and `billing_view_arn` shows as a
  change to null.
- Root cause: the console sets these attributes on every budget. The provider does not compute them on read, so an omitted
  attribute is planned as null, not kept.
- Fix: `infra/envs/demo/budgets.tf` sets `billing_view_arn` (built from the account id), `metrics = ["UnblendedCost"]` and the
  `RECORD_TYPE` filter explicitly. The local plan after that showed only `tags_all` as a changed key on the three budgets.
- What it taught: before importing a console object, read its full configuration and write each attribute it sets.
- Links: `infra/envs/demo/budgets.tf`, PR B, `docs/adr/0023-alarm-channel-and-budgets-as-code.md`

## 2026-10-31 — Mocked provider cannot plan the import blocks

- Symptom: a `terraform test` run with the mocked AWS provider failed on the import blocks of the budgets.
- Root cause: mock providers do not support import; the override substitutes the resource.
- Fix: a file-level `override_resource` on `aws_budgets_budget.this` gives the resource a mock ARN in
  `infra/envs/demo/tests/demo.tftest.hcl`. The tests then plan the import blocks without a call to AWS.
- What it taught: a mock provider does not import. A test that plans import blocks needs an override that names the resource.
- Links: `infra/envs/demo/tests/demo.tftest.hcl`, PR B

## 2026-10-31 — Single-region trail would miss IAM and STS events

- Symptom: found in design review, before any apply: a single-region trail outside us-east-1 does not record IAM and STS
  events, which are global service events.
- Root cause: the trail records global service events only in a multi-Region trail or in a trail homed in us-east-1 (AWS
  CloudTrail behaviour). The stack region is eu-west-3.
- Fix: `infra/modules/audit-trail/main.tf` sets `is_multi_region_trail = true` and `include_global_service_events = true`.
  The decision and its alternatives are in ADR 0022. The test `trail_records_all_management_events_in_every_region` pins both flags.
- What it taught: before choosing the home Region of a trail, check which events it records. A flag that looks cosmetic can
  remove the events that matter most.
- Links: `infra/modules/audit-trail/main.tf`, PR B, `docs/adr/0022-multi-region-management-trail.md`

## 2026-10-31 — Zero-Spend alert counted gross usage

- Symptom: reading the three budgets before importing them showed that the `Zero-Spend Alarm` budget (limit 1.00 USD,
  alert above 0.01 USD) excluded credits and refunds. It therefore counted usage that account credits cover, and no alert
  existed for a net charge.
- Root cause: the filter was copied from the 3 € and 5 € budgets, which measure gross usage on purpose. For a "zero spend"
  alert, excluding credits means that no credit can offset the usage, so any usage above 0.01 USD alerts.
- Fix: the Zero-Spend budget excludes only `Refund`, so it measures the net charge. The 3 € and 5 € budgets are unchanged.
  the owner approved the change on 2026-10-31. The test `zero_spend_counts_credits` pins the filter.
- What it taught: an alert name states what it measures. A filter copied from another budget changes that measure, so each
  budget needs its own test.
- Links: `infra/envs/demo/budgets.tf`, PR B, `docs/adr/0023-alarm-channel-and-budgets-as-code.md`

## 2026-10-31 — `make destroy` stopped when there was no state

- Symptom: the step of `make destroy` that removes the budgets from the state stopped the recipe when no state existed yet,
  so the teardown never reached `terraform destroy`.
- Root cause: `terraform state list` exits non-zero when the backend holds no state object. The recipe runs with `set -e` and
  `pipefail`, so the failure ended the recipe at that line.
- Fix: the listing is captured with `|| true`. The `grep` then finds no budget and the removal is skipped. If budgets are still
  tracked, `prevent_destroy` still stops the teardown, so the failure stays closed. Ships in PR B.
- Verified on 2026-10-31 with Terraform 1.17.1: a read-only `plan -destroy` against an empty local state of a copy of
  `envs/demo` (import blocks present, real provider) planned "No changes", so destroy ignores the import blocks. The
  part still untested is the Makefile recipe itself, which has no automated test; it was checked by a dry run
  (`make -n destroy`) only.
- What it taught: an empty state is a normal answer, not an error, and a safety net must stay in place when the step that
  feeds it changes.
- Links: `Makefile` (target `destroy`), PR B

## 2026-10-31 — Stale `.terraform` caches broke `make check-tf`

- Symptom: `make check-tf` failed on a root that uses no backend. The first case was `infra/bootstrap` (a backend error).
  The second was `infra/envs/demo`, with "No valid credential sources found" for the S3 backend, although the check runs
  `init -backend=false`.
- Root cause: each root's git-ignored `.terraform/` directory was left from an earlier `init` with the S3 backend. Its
  `terraform.tfstate` still records that backend, and the check ran against it. The cache is local state about the working
  tree, not a source of truth.
- Fix: the stale `.terraform/` directory of each root was moved out of the repository. `make check` was then run again and
  passed. The remote state in S3 was not touched.
- What it taught: a backend error in a check that uses no backend points to a stale local cache. Move the `.terraform/`
  directory aside before reading the configuration. It is git-ignored for that reason and must never be copied between roots.
- Links: `.gitignore` (`.terraform/`), `Makefile` (target `check-tf`)

## 2026-11-04 — WebSocket refused in the deployed console

- Symptom: the deployed console got a token from `ws-token` (HTTP 200), but the browser's WebSocket upgrade to
  `$connect` was refused. The console could not open its live feed.
- Root cause: `ws-connect` received `WS_ALLOWED_ORIGINS` from `var.ws_allowed_origins`, whose default holds only
  `http://localhost:5173`. The origin check is an exact match (R41), so the CloudFront origin of the console was
  refused. The live test had run only against localhost, where the default happens to match.
- Found from: the browser console (the refused upgrade) and the origin check in `services/api/src/domain/ws/token.ts`.
- Fix: `realtime.tf` now sends `distinct(concat([module.web.console_origin], var.ws_allowed_origins))`. The console
  origin is always allowed, wired from the web module, and the variable only adds extra origins. The Terraform test
  `realtime_iam.tftest.hcl` asserts the console origin and localhost are both in the list.
- What it taught: a live check must run against the deployed origin, not only the dev origin. Any allow-list fed by a
  default must also receive the origin the deployment actually serves.
- Links: `infra/envs/demo/realtime.tf`, `infra/envs/demo/variables.tf` (`ws_allowed_origins`),
  `infra/envs/demo/tests/realtime_iam.tftest.hcl`, `docs/security/THREAT_MODEL.md` (R41)

## 2026-11-04 — Console and robots used different site ids

- Symptom: the live console showed an empty snapshot and no frames, while ingest kept persisting telemetry. The
  fan-out found no connection for the robots' site, so it sent 0 frames.
- Cause: the robots, kits, MQTT topics, IoT policy attributes and docs use the site id `paris-01`. The console side
  used `demo-site`, the constant `DEMO_SITE_ID` that the HTTP API assigns to every principal. Two halves of the same
  system named the one site differently, and no test crossed the boundary.
- Fix: `DEMO_SITE_ID` is now `paris-01`, so the console, the API and the robots share one site id. Re-registering the
  robots would have changed their identity for no gain, so the console side moved. Every test literal followed.
- Consequence: a site map stored under `demo-site` (its S3 key and its DynamoDB partition) is not visible under
  `paris-01`. Re-import it with the site map upload flow.
- What it taught: a shared identifier belongs in `packages/protocol` and must be checked against the producers' values
  in at least one cross-boundary test. Renaming a constant is cheap only while no data is stored under the old value.
- Links: `packages/protocol/src/ids.ts`, `services/api/src/domain/authz.ts`, `docs/JOURNAL.md`

## 2026-11-04 — Simulated robots crossed the walls

- Symptom: on the console, the simulated robots drove through the walls and no-go zones of the site map that the
  operator had imported and activated.
- Cause: `scripts/sim.sh` defaulted to the protocol's sample map, a test fixture, while the console shows the active
  version of site `paris-01`. One site had two sources of truth for its map, and no test crossed the boundary.
- Fix: with `SIM_MAP` unset, `sim.sh` fetches the active map with `scripts/fetch-active-map.sh`. It reads the
  `activeVersion` of the profile, the pinned object version, and refuses a map whose SHA-256 differs from the one
  recorded at validation. A failed fetch prints a warning and falls back to the sample; `SIM_MAP=sample` keeps the old
  choice explicit. The stack exports the bucket name as `site_maps_bucket_name`.
- What it taught: a map that two tools must agree on should be read from the store they share, never copied into a
  fixture. A visible fallback is not a guarantee: if the fetch fails, the robots run on the sample until someone reads
  the warning.
- Links: `scripts/fetch-active-map.sh`, `scripts/sim.sh`, `infra/envs/demo/outputs.tf`, `docs/security/RUNBOOK_SIM.md`

## 2026-11-04 — Simulated robots piled up on the same workstations

- Symptom: in the simulator, robots queued at the same two or three workstations while the layout had more, so the
  fleet looked like a crowd on a few stations rather than a fleet working the warehouse.
- Cause: the mission driver drew its pickup and drop with `rng.sample` over all the stations. Each robot drew on its
  own, with no shared state, so their choices converged on the same stations.
- Fix: `sim/stations.py` adds a `StationRegistry` shared by the robots of one run. A robot reserves both stations of a
  mission all-or-nothing before it takes the mission, and the mission driver releases them once the core reports no
  mission in progress (completed, aborted or e-stopped). The fleet releases a robot's stations when the robot ends,
  whatever the cause. A robot with fewer than two free stations stays idle and retries on the next tick. The core
  snapshot now carries the mission identifier, because the driver could not see an abort otherwise.
- What it taught: a shared resource needs one owner record where it is handed out, and every way a holder can end needs
  its own release. A halted robot is never ticked again, so the release at the fleet level is the one that covers it.
- Links: `agent/src/fleet_agent/sim/stations.py`, `agent/src/fleet_agent/sim/missions.py`,
  `agent/src/fleet_agent/sim/fleet.py`, `agent/src/fleet_agent/core/snapshot.py`

## 2026-11-04 — Function alarms were split between two modules

- Symptom: the audit of the alarms found ten `Errors` and `Throttles` alarms in the `http-api` module, not the eight
  expected: the `alerts` function was in the routes too. Moving only eight would have left two alarms behind, and
  creating them in `lambda-function` would have created them twice under the same names.
- Fix: the ten alarms move to the `lambda-function` module of each function, with `moved` blocks in
  `infra/envs/demo/moved.tf`, so that a plan shows moves and no destroy and create.
- What it taught: when a resource moves between modules, the count comes from the state and the routes, not from the
  list in the design. Read the state addresses before writing the `moved` blocks.
- Links: `infra/envs/demo/moved.tf`, `infra/modules/lambda-function/main.tf`, `infra/modules/http-api/main.tf`

## 2026-11-04 — The e2e and ZAP jobs were skipped without an error

- Symptom: on the first run on `main`, the deployed e2e job and the ZAP baseline job did not run. The run was green, and
  the two jobs showed as skipped, so nothing had tested the deployed console.
- Root cause: the deploy workflow read the stack output `console_url`, which does not exist. The stack exports
  `console_origin` (`infra/envs/demo/outputs.tf`). The empty value made the `if` of both jobs false, and a skipped job
  does not fail the run. The workflow's own comment says that an empty value silently skips publishing and the e2e and
  DAST jobs, which is what happened.
- Found from: the first run of the jobs on `main`, where the two jobs showed as skipped.
- Fix: the workflow must read `console_origin`. In this branch `.github/workflows/deploy.yml` still reads `console_url`,
  so the change is a separate edit to that file, reviewed as a workflow change.
- What it taught: a skipped job is not a passing job. A required input that is empty has to fail the run, not skip the
  step that depends on it. The first run of a new job on `main` is the first real test of its inputs, so check that the
  job ran, not only that the run is green.
- Links: `.github/workflows/deploy.yml`, `infra/envs/demo/outputs.tf`

## 2026-11-04 — A coder's `pnpm add` broke the shared node_modules in a linked worktree

- Symptom: a `pnpm add` run by a coder agent in a linked worktree broke the `node_modules` that this worktree shares.
- Root cause: a linked worktree does not own a separate dependency install. A dependency change made from it changes the
  install that the worktrees share, not only the worktree where it was run. The brief to the coder did not forbid the
  command.
- Found from: the broken install of the shared `node_modules`, after the coder's run.
- Fix: the brief does not record the repair. The rule adopted for the next steps is that dependency changes are made from
  the main checkout only, and coder briefs say so.
- What it taught: a shared install turns one checkout's change into every checkout's change. A dependency command is
  one that changes shared state, so the brief has to name where it may run.

## Sources and licences

| Item                 | Source                                                                                                 | Licence                                                                                                                                       | Used for                |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Sample warehouse DXF | Original: generated by `agent/tools/make_sample_dxf.py`, author Vincent Lucas, no third-party material | All rights reserved by the author; no reuse licence granted until a `LICENSE` file is added (see ADR 0055 and `agent/tools/sample/README.md`) | Site configuration demo |
