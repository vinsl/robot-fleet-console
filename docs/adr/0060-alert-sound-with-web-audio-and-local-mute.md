# ADR 0060 — Alert sound with Web Audio tones, autoplay unlock and a local mute

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-ALR-2 (visual and sound, mute), NFR-A11Y-1 (no information by sound alone)
- Threat: R78 (sound needs a user gesture), T33 (alert flood), R81 (client-side preference only)
- Implemented in: `apps/console/src/live/alert-sound.ts`, `apps/console/src/live/sound-preference.ts`,
  `apps/console/src/alerts/AlertNotifier.tsx`, `apps/console/src/alerts/sound-burst.ts`,
  `apps/console/src/layout/SoundToggle.tsx`, `apps/console/src/layout/Shell.tsx`,
  `apps/console/src/theme/robot-state-visuals.ts` (`ALERT_VISUALS`, sound per severity)

## Context

DESIGN 3.3 (locked) asks for a sound on alerts: a Major alert sounds once when it opens, and a Critical alert repeats
until it is acknowledged. Browsers keep audio suspended until the user has interacted with the page (autoplay policy),
so the first alert of a page may be silent. The content security policy of the console allows no `media-src` origin,
and a sound file would add an asset with a licence to check. The sound must never be the only notice: an operator
with the sound off, or with the browser blocking it, still needs to see and read the alert.

## Decision

- **Tones are generated with the Web Audio API.** No audio file, no `media-src` change in the CSP. A Critical pattern is
  two tones, a Major pattern is one tone, with a short linear ramp to avoid clicks.
- **The audio context is created lazily** on the first unlock or play. The first `pointerdown` or `keydown` on the page
  resumes it. If it is still suspended when a sound is due, the preference is marked blocked, and the status line shows
  "Click to enable alert sound". The sound control then calls the unlock.
- **Rules of sound** (`AlertNotifier.tsx`):
  - A Major alert sounds once, when a live frame opens it. A page load does not replay it.
  - A Critical alert sounds at once while one is open, and then every `repeatMs`, until it is acknowledged. This covers
    a page load too, because the design asks for the repeat until acknowledgement.
  - Nothing sounds while the operator has muted the sound. The announcement still happens.
  - The tab being hidden does not mute the sound: an operator in another tab must hear a Critical alert.
  - A burst gate (`sound-burst.ts`) lets one pattern play per window, so several alerts in the same second do not stack
    into noise, and a flood of alerts cannot keep the operator's speakers busy (security finding L3).
- **Every alert is also announced.** Two visually hidden live regions carry the text: polite for Major, assertive for
  Critical. The alert pill is the visual notice, shown from the same moment.
- **Mute is a local preference.** It is stored under `mfc.alertSound` (`on` or `off`). It is not a credential and it
  is not sent to the server. Storage failures are ignored, and the preference then lasts for the page.

## Alternatives considered

| Option                                            | Pros                           | Cons                                                                                  | Why not                                                                    |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| An `<audio>` element with an MP3 or OGG asset     | Richer sound, one call         | An asset to license and ship; a `media-src` entry in the CSP; the same autoplay limit | No asset licence is needed for tones, and the CSP stays unchanged          |
| Sound on page load too, for every open alert      | An operator who joins hears it | A reload replays a Major alert the operator already heard                             | DESIGN 3.3: the repeat is for Critical alerts that are still open          |
| Mute stored on the server with the user's profile | Same mute on every browser     | A new endpoint and table for a preference; more data about operators                  | Not needed for the demo; a per-browser mute is enough                      |
| Mute the sound when the tab is hidden             | Less noise in the background   | An operator working in another window misses a Critical alert                         | Safety first: the Critical repeat is the only signal the operator may have |

## Consequences

- The sound depends on the browser: a first-page alert may need one click. Until then the status line and the pill show
  the alert, and the live regions announce it (R78).
- A muted operator does not hear a Critical alert. The pill and the announcement remain, and the mute is visible on the
  status line (state shown by icon and text, not colour alone).
- The sound adds no request, no asset and no cost. It adds one `localStorage` key, which the security checklist lists.
- The tone frequencies, durations and gain are tokens (`alertSound`), not literals in the code.
- A change to the sound rules (for example a page-load repeat) is a change to this ADR and to `AlertNotifier.tsx` docs.
