# ADR 0067 — Console video viewer: vendored KVS bundle, identity pool credentials and the ID token in memory

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-VID-1, FR-VID-4, FR-ROB-6, SEC-ID-3, SEC-WEB-1, SEC-WEB-2
- Threat: T61, T59 (ID token), R94, R95
- Implemented in (planned, M9): `apps/console/src/video/kvs-credentials.ts`, `apps/console/src/video/kvs-viewer.ts`,
  `apps/console/src/video/use-robot-video.ts`, `apps/console/src/video/video-stats.ts`,
  `apps/console/src/video/vendor-manifest.ts`, `apps/console/src/video/VideoPane.tsx`,
  `apps/console/public/vendor/kvs-webrtc.min.js`, `apps/console/test/video/vendor.test.ts`
- Builds on: ADR 0026 (vendored bundle procedure), ADR 0037 (robot video page)

## Context

The robot's camera is the only real video in the demo (FR-ROB-6). The robot publishes it to a KVS WebRTC signalling
channel named after its robot id (ADR 0006, ADR 0025). The robot page already plays it (ADR 0037), and the console has
to show the same feed inside the robot panel, with the overlay of FR-VID-4. Four constraints shape the design:

- The viewer needs AWS credentials in the browser. Only the Cognito identity pool gives them, and its role allows viewer
  actions only (SEC-ID-3).
- The console CSP forbids inline scripts and allows no new script origin (SEC-WEB-1).
- Tokens stay in memory (SEC-WEB-2), so the ID token used to call the identity pool cannot be stored.
- The signalling library is third-party code, already reviewed for the robot page (ADR 0026).

## Decision

- **Vendored bundle.** `kvs-webrtc.min.js` 2.9.0 is restored byte for byte from the git history of the video spike into
  `apps/console/public/vendor/`, with a manifest and a test that checks its SHA-256. This follows the ADR 0026 procedure.
  No npm package is used for the signalling code.
- **AWS SDK v3 clients** for Kinesis Video, Kinesis Video Signaling and Cognito Identity, at exact pinned versions through
  pnpm.
- **Credentials from the identity pool.** The console gets an identity id and the temporary credentials with the ID token
  from `AuthClient.getIdToken()`. The ID token is used only in memory. The credentials are cached until 2 minutes before
  their expiry and are never persisted.
- **Channel name.** `${THING_NAME_PREFIX}${robotId}`, built from a validated `RobotId`, so a request can name only the
  robot's own channel.
- **Loading the bundle.** A same-origin `<script src="/vendor/kvs-webrtc.min.js">` is added once at runtime. No inline
  script is added, and the CSP is unchanged.
- **Simulated robots** get the "No camera" tile and no viewer. Only `simulated === false` robots load the viewer.
- **Failure.** If the bundle, the credentials or the connection fails, the pane shows "Video unavailable". The overlay
  (name, state, position, speed and the round-trip time from the WebRTC statistics) and the command panel keep working.

## Alternatives considered

| Option                                  | Pros                               | Cons                                                                                   | Why not                                                                  |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Hand-written signalling client          | No third-party code                | More code to write and test in a 2-day window; a protocol to get right twice           | ADR 0026 decided the vendored bundle, and the robot page already runs it |
| npm package for the signalling code     | Version managed by the lockfile    | A new supply chain step for the same code                                              | ADR 0026 chose the vendored procedure with a hash test, not a package    |
| Credentials through a new Lambda (STS)  | The browser holds no identity call | A new function, a new role and an API hop on every refresh, for the same viewer rights | The identity pool already gives the viewer actions and needs no new code |
| Store the credentials in `localStorage` | Survive a reload                   | A credential at rest in the browser; SEC-WEB-2 forbids it                              | Credentials are cached in memory only                                    |
| Inline script for the bundle            | One request fewer                  | The CSP forbids inline scripts (SEC-WEB-1)                                             | A same-origin file is allowed by the CSP and costs one request           |

## Consequences

- The bundle is third-party code (R94). Its hash is pinned, it is served from the console origin, and the CSP does not
  change. An update is a manual change to the vendor folder, the manifest and the test, reviewed as a dependency change.
- Every role may watch the video, because the identity pool gives every role the viewer actions (R95). Viewers can watch
  but cannot command, as FR-VID-2 requires.
- The ID token is in browser memory only for the identity call. It is never sent to the video endpoints and never logged
  (T59).
- The identity pool role is scoped to `channel/mfc-demo-*/*` (T61). A bad robot id cannot reach another channel, because
  the id is validated before the name is built.
- The viewer adds a bundle to the console download, only on the robot panel route.
