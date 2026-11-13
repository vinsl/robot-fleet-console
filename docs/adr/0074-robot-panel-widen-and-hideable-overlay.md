# ADR 0074 — Robot panel: widen toggle and hideable video overlay

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-VID-4, NFR-A11Y-1

## Context

The robot side panel shows the live video in a 16:9 frame, with an overlay in the top left corner (name, state,
position, speed, and the latency chip). In the live test on the Kali, the panel was about 470 px wide, and the overlay
covered the camera. The operator could not see the image that the overlay was meant to annotate. The design of ADR 0004
is locked, so this is a visual change, and it needs a record.

## Decision

- A toggle on the left edge of the robot panel widens it to `--panel-w-expanded` (60vw). The token is in
  `apps/console/src/theme/tokens.css` and `tokens.ts`.
- A second toggle hides the video overlay (name, state, position, speed). The latency chip stays visible.
- Both toggles are buttons with an accessible name and a state (`aria-expanded`, `aria-pressed`), reachable by keyboard.
- `docs/design/DESIGN.md` section 2.2 describes both toggles.

## Alternatives considered

| Option                           | Pros                     | Cons                                                                            | Why not                                                            |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Shrink the overlay               | No toggle needed         | Text falls below a readable size in a narrow panel; still covers the image      | The overlay cannot fit a 470 px frame without hiding the camera    |
| Move the overlay below the video | Nothing covers the image | Costs height in the panel; the readouts move down and the panel must scroll     | The panel already holds the readouts, the lock line and the e-stop |
| Full-screen video mode           | Largest picture          | A third layout to design and test; the readouts and the e-stop leave the screen | The e-stop must stay visible at all times (FR-CMD-4)               |

## Consequences

- The operator can see the camera in a narrow panel, and can keep the overlay off when the image matters more.
- While the overlay is hidden, the position is not shown in the panel, because the design places it only in the
  overlay. The state chip and the speed readout stay in the panel.
- The widen toggle covers the panel's width on wide screens only. The phone layout (section 2.4) is unchanged.
- This changes the locked design (ADR 0004). The change is recorded here and in `docs/design/DESIGN.md`, and the
  design stays the source of truth for visuals.
- Cost: none. Security: none.
