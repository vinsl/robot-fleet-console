# ADR 0037 — Robot video page: spike promoted to apps/robot-video, committed build with manifest, visuals deviation

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-VID-1, FR-VID-2, FR-VID-3 (master side only), NFR-A11Y-1, NFR-I18N, SEC-WEB, NFR-COST-1
- Threats: T8, T9, T21, T24, R36
- Supersedes nothing. Extends ADR 0025 (spike) and ADR 0026 (vendored KVS bundle).

## Context

ADR 0025 built a spike with two pages, a master for the robot VM and a viewer for the operator, and a hand-made
channel. Its pages used the operator's administrator session, pasted in by hand (R19). M4 removes that exception: the
robot master uses its own credentials from the agent (ADR 0036), and the spike's session paste is deleted. The master
code, the vendored KVS bundle and its tests are worth keeping, so the spike is promoted instead of rewritten.

Two repository rules meet here. Visual changes come from the locked design (ADR 0004, `docs/design/DESIGN.md`), and
robot visuals come from `robot-state-visuals.ts`. The page runs on the robot VM, where the agent serves it. The VM has
no Node toolchain (ADR 0025: the VM never builds), so the agent package must carry the built page.

## Decision

1. **Promotion.** `apps/video-spike` is renamed `apps/robot-video` (package `@mfc/robot-video`) with `git mv`, and only
   the master path is kept. The viewer page, its entry page, the latency panel, the session paste, the mint script and
   the tarball script are removed. The vendored KVS bundle (ADR 0026), its vendor script, its manifest and its
   `vendor.test.ts` move with it. The viewer code stays in git history for M9, which vendors by the same procedure.
2. **Committed build.** The built page is committed in `agent/src/fleet_agent/video/static/` with `MANIFEST.sha256`
   (19 files, 494 KB in total: the page, its fonts, the bundle and its licences). The agent loads it at start and
   checks every hash (ADR 0036). `make video-page-check` (run by `make check-ts`) rebuilds the page into a temporary directory,
   writes a manifest with `apps/robot-video/scripts/write-manifest.mjs` and fails when the result differs from the
   committed directory, so the bytes in the agent are the bytes of the source. The static folder is about 494 KB in git.
   This size is accepted: a page of this kind needs its fonts and its bundle, and a reviewer reads the build by its
   manifest, not file by file.
3. **Visuals deviation from `robot-state-visuals.ts`.** The page is plain TypeScript, without React or lucide, so it
   cannot import the console's components. It draws its banner from `BANNER_VISUALS` (`apps/robot-video/src/ui/banner.ts`):
   an inline SVG octagon for the e-stop and a dashed circle for teleoperation, with text. Colours come from console
   tokens only (`--state-estop`, `--state-human`, `bg-raised` and `text-primary` through the page stylesheet). The file
   `apps/robot-video/test/parity.test.ts` imports `STATE_VISUALS` from `robot-state-visuals.ts` and the console tokens,
   and fails if the shape or the token of the e-stop or the teleoperation banner differs from the console.
4. **E-stop banner colour (decided with the owner).** The e-stop banner uses the console `state.estop` token on the
   `bg-raised` background, with `text-primary` text, the same treatment as the teleoperation banner. It does not use
   the `estop.fill` token. The parity test checks the icon at 3:1 or more and the teleoperation text at 4.5:1 or more on
   the raised background. The shape and the text carry the state, so colour is not the only signal.
5. **Page strings.** Every string goes through `apps/robot-video/src/i18n` (`en.json` and `fr.json`). The French copy
   was validated by the owner. A problem the page does not recognise shows the generic sentence, and a `401` from the agent
   shows the `error.unauthorised` message.
6. **Page safety.** Text is written with `textContent` only. The page has no inline script, its scripts come from its own
   origin, and its vendored script carries a pinned SRI hash (`vendor.test.ts`, `built-page.test.ts`). The stylesheet
   names design tokens only, checked by `styles.test.ts`.

## Alternatives considered

| Option                                               | Pros                                                   | Cons                                                                                           | Why not                                                                |
| ---------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Rewrite a new package from scratch                   | No spike code to clean up                              | Throws away tested code: viewer slots, candidate buffer, endpoints, ICE, reconnection          | Promotion keeps the tested master path                                 |
| Build the page on the VM at run time                 | No committed bytes                                     | The VM has no Node toolchain; a build on the robot widens what runs there                      | Committed build with a drift check in `make check`                     |
| Commit the page without a manifest                   | Less to maintain                                       | The agent cannot tell a changed file from an intended one; an unlisted file could be served    | The manifest lists every file, and an unlisted file is never served    |
| React page reusing `robot-state-visuals.ts` directly | Single source for visuals, as the repository rules ask | React and lucide in a safety banner for two states; a larger bundle                            | Plain TypeScript, with a parity test that fails on drift               |
| `estop.fill` token for the e-stop banner             | Matches the console's e-stop badge                     | The banner would then look different from the teleoperation banner, which uses the state token | Decided with the owner: the same treatment as the teleoperation banner |

## Consequences

- Easier: one package holds the robot page, its tests and the vendored bundle, and the agent ships the exact bytes that
  `make check` built and compared. The page reaches no secret from the operator's session, since the spike's paste is gone.
- Harder: a change to the page needs `make video-page` and a commit of `agent/src/fleet_agent/video/static/`. A visual
  change of the banner needs a new ADR, because the design is locked (ADR 0004).
- Watch: the static folder adds about 494 KB to the repository on each rebuild, because fonts and bundle hashes change
  together. A reviewer reads a page change through its manifest diff.
- Security: the page is not a trust boundary for credentials (ADR 0036), and a modified page is caught by the manifest
  check at start and by the drift check in `make check` (T24, R36). A browser extension that reads the page memory remains a
  residual risk (R36). The page CSP `connect-src` names the region's KVS hosts only (ADR 0036).
- Accessibility: the banner states are shape, icon and text, with no colour alone (NFR-A11Y-1).
- Threats: T8, T9, T21, T24, R36. See `docs/security/THREAT_MODEL.md`.
