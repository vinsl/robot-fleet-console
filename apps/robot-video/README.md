# @mfc/robot-video: the robot's local video page

The page that the robot agent serves on `127.0.0.1` so that an operator at the robot's machine can see the camera and
share it to the fleet over Kinesis Video Streams (KVS) WebRTC. The agent is the KVS master; the page holds the master
side of the session and nothing else. The design is in ADR 0036 (agent side) and ADR 0037 (this package).

The page is English and French only through `src/i18n`. It is not part of the operator console, so it has no React and
no console components. Its colours come from the console tokens (`apps/console/src/theme/tokens.css`).

## What is in the package

| Path                           | Role                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `index.html`, `src/main.ts`    | Page entry and page controller: claim, session, status, banner, camera preview.          |
| `src/master.ts`                | Master side of the KVS session: answers the offers of up to three viewers.               |
| `src/lib/`                     | Pure logic: claim client, session, endpoints, ICE servers, viewer slots, status poller.  |
| `src/kvs/`                     | AWS SDK calls and the loader of the vendored KVS SDK.                                    |
| `src/ui/`                      | Banner mapping (`banner.ts`) and DOM helpers. Text is written with `textContent` only.   |
| `src/i18n/`                    | `en.json` and `fr.json`, and the typed lookup.                                           |
| `public/vendor/`               | KVS WebRTC browser bundle, unmodified, with its licences and pinned SRI hash (ADR 0026). |
| `scripts/write-manifest.mjs`   | Writes `MANIFEST.sha256` next to the built files.                                        |
| `scripts/vendor-kvs-webrtc.sh` | Re-vendors the KVS SDK with checks. Only for a deliberate SDK update.                    |

## Commands

From the repository root, after `pnpm install --frozen-lockfile`:

| Command                                        | What it does                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm --filter @mfc/robot-video typecheck`     | `tsc -p tsconfig.json`.                                                            |
| `pnpm --filter @mfc/robot-video test`          | Unit tests (Vitest), including the banner parity test against the console visuals. |
| `pnpm --filter @mfc/robot-video test:coverage` | The same tests with coverage.                                                      |
| `pnpm --filter @mfc/robot-video build`         | `vite build` into the agent's static folder, then `write-manifest.mjs`.            |
| `pnpm --filter @mfc/robot-video vendor:kvs`    | Re-vendors the KVS SDK (`scripts/vendor-kvs-webrtc.sh 2.9.0`). Not a routine step. |

The agent does not build this package. The built page is committed in
`agent/src/fleet_agent/video/static/`, with its `MANIFEST.sha256`:

- `make video-page` rebuilds it into the committed folder. Run it after a change to this package, then commit the result.
- `make video-page-check` (run by `make check-ts`) builds into a temporary folder and compares it byte for byte with the
  committed folder. Any edit that was not rebuilt, and any build that is not reproducible, fails the check.

The agent loads the folder at start, checks each file against the manifest, and serves only the files it lists
(ADR 0036). A file on disk that the manifest does not list is never served.

## Security notes

- The page holds no AWS credential at rest. The agent hands it temporary credentials of the robot's own channel,
  in memory, after the one-time claim (ADR 0036). The page never writes them to web storage, cookies or the URL.
- The page Content Security Policy is sent as a response header by the agent. `connect-src` names the KVS endpoints of
  the robot's region only; the signaling hosts are per channel, so the host part is a wildcard. The WebRTC transport is
  outside `connect-src`, so the policy blocks script injection but not data sent over ICE.
- The one-time address is removed from the address bar before the claim is sent. A page that is reloaded needs a new
  address from the agent (`SIGUSR1`).

## Limits

- Only the master side is here. The viewer page is removed; the operator's viewer comes in M9.
- The page shows the camera, the banner and the viewer count. It sends no robot command.
