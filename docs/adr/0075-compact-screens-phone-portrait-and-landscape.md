# ADR 0075 — Compact screens: one layout for a phone in portrait and in landscape

- Status: accepted
- Date: 2026-11-04
- Requirements: SPEC step 8 (remote use on a phone), NFR-A11Y-1

## Context

The compact layout of the console (icons only in the dock and the status line, full-width alert pill) was chosen by
width only, below 640 px. In the live test on a phone over 4G, two defects showed up:

- In portrait, the KPI summary chip and the alert pill were both placed at the top of the map and overlapped.
- In landscape, the phone is wider than 640 px, so it got the desktop layout on a screen about 390 px high. The status
  line, the dock, the KPI corners and the map controls took most of the height, the map shrank to a small strip, and
  the pill overlapped the dock.

The design (ADR 0004) is locked, so a change to the layout needs a record.

## Decision

- A screen is compact when it is narrow or short: `@media (max-width: 639px), (max-height: 500px)`. Every compact rule
  of the status line, the dock, the sound toggle, the alert pill, the KPI corners and the map tilt uses this one query,
  so a phone in landscape gets the layout of a phone in portrait.
- Compact screens do not show the KPI corners or the KPI summary chip. The numbers stay on the KPI page of the dock.
  The summary chip, its style and its `summary` string are removed.
- On a short landscape screen only (at most 500 px high), the dock, the map controls and the alert pill are halved, and the
  pill leaves the top banner for the bottom left corner. Half-size controls are below the 44 px touch target
  (`--control-h-coarse`): this is the owner's choice, made to keep the map visible, and it applies to the landscape
  orientation only.
- The tilt of the map, which a script decides (`useCompactTilt`), uses the same query, with the height as the token
  `breakpoint.compactHeight`.
- The site editor keeps its width-only rule: its grid stacks by width, and a short wide screen still has room for two
  columns. The exemption is named in the test.
- A test (`apps/console/test/layout/compact-media.test.ts`) fails when another stylesheet uses the width-only query, or
  when the script query drifts from the stylesheets.

## Alternatives considered

| Option                         | Pros                        | Cons                                                             | Why not                                                 |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Keep the summary chip, move it | KPI numbers stay on the map | The top of a short screen is already full                        | The alert pill is the one thing an operator must see    |
| Lock the phone to portrait     | One layout to maintain      | Not possible for a web page, and it blocks tablets               | The browser cannot lock the orientation                 |
| Scale the whole layout down    | No new rules                | Text and touch targets fall below the readable and tappable size | Touch targets must stay at 44 px (`--control-h-coarse`) |

## Consequences

- A short desktop window (under 500 px high) also gets the compact layout. This is acceptable: it has the same lack of
  room.
- The KPI numbers are no longer on the map of a compact screen. They are one tap away on the KPI page.
- Checked by the width and height rules in the test above. A visual check on a real phone, in both orientations, is
  part of the live protocol (block L).
- Cost: none. Security: none.
