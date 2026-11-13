# ADR 0026 — Vendored KVS WebRTC browser bundle, and AWS SDK v3 through the lockfile

- Status: accepted
- Date: 2026-11-01
- Requirements: SEC-SUP-1, FR-VID-1, NFR-MAINT-1

## Context

The M3 video spike runs KVS WebRTC in browser pages (ADR 0025). The SDK's npm package
(`amazon-kinesis-video-streams-webrtc`) is built for Node and React Native: its dependency tree pulls `jsdom`, `ws`
and `isomorphic-webcrypto`, with `"*"` ranges to Expo and React Native packages. None of that runs in a browser, and
installing it would put that surface into the workspace. The SDK also ships an official browser bundle
(`dist/kvs-webrtc.min.js`), with its licence files, that needs no dependency at all. The AWS SDK v3 clients, by
contrast, are ordinary npm packages that the lockfile already pins and the release-age rule already covers.

## Decision

- **The browser bundle is vendored.** `apps/video-spike/public/vendor/` holds `kvs-webrtc.min.js` 2.9.0, unmodified,
  with `kvs-webrtc.LICENSE`, `LICENSE.txt` and `NOTICE.txt` from the same release. The SDK is not a dependency of
  `package.json`.
- **A script brings the files in, and checks them.** `scripts/vendor-kvs-webrtc.sh <version>` (run as
  `pnpm --filter @mfc/video-spike vendor:kvs`) downloads the registry metadata and the tarball into a directory it
  creates and removes, refuses a version published less than 14 days ago, refuses a tarball whose SHA-512 differs
  from the npm integrity, extracts only the four named members (refusing any symlink), and installs them with mode 644 (owner-writable, world-readable). The mode does not make the files immutable: the
  pinned hash in the test is what detects a change.
  It never runs anything from the tarball.
- **The SHA-256 is pinned.** `src/kvs/vendor-manifest.ts` records the version, publication instant, npm integrity and
  SHA-256 printed by the script. `test/vendor.test.ts` recomputes the hash and checks the version banner and the
  licence files, so a changed file fails the tests.
- **The bundle is outside lint and format.** It is listed in the ESLint global ignores and in `.prettierignore`:
  it is a third-party byte-for-byte copy, and linting it would only report noise.
- **The AWS SDK v3 comes through pnpm.** `@aws-sdk/client-kinesis-video` and
  `@aws-sdk/client-kinesis-video-signaling` are pinned exactly in the lockfile, under the 14-day release age of
  `pnpm-workspace.yaml`. The browser bundle does not replace them.
- **The rule for later milestones:** the M9 console viewer uses this same procedure (vendored bundle, script, manifest,
  test) and not the npm package.

## Alternatives considered

| Option                                              | Pros                                        | Cons                                                                                                     | Why not                                                                       |
| --------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Install the npm package                             | The standard way; updates through `pnpm up` | Pulls `jsdom`, `ws`, `isomorphic-webcrypto` and `"*"` ranges to Expo and React Native into the workspace | Node and React Native code the browser never runs, and a wide dependency tree |
| Load the SDK from a CDN script tag                  | No file in the repository                   | Third-party origin, not pinned, and a CSP exception for the CDN                                          | The page would trust a server it does not pin                                 |
| AWS SDK v2 browser bundle (used by the KVS samples) | Matches the samples                         | End of support                                                                                           | Unmaintained                                                                  |

## Consequences

- Updating the SDK is a deliberate act: run the script with the new version, copy the printed values into the manifest,
  and commit the file, the manifest and the test together. The 14-day age rule holds for the SDK as it does for every
  other dependency.
- The repository carries a 31 KB minified file and its licence files. Semgrep and Trivy scan them; the findings, if any,
  are handled with a reason in the PR, not by excluding the folder without one.
- The file runs inside the pages' CSP (`script-src 'self'`): it must not need `eval` or inline script. The M3 pages were
  built on that condition.
- Security: a compromised upstream release would be caught only if the new version is reviewed before the manifest
  changes. The pinned SHA-256 makes the review visible in the diff.
