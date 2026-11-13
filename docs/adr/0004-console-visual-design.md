# ADR 0004 — Console visual design: "Plan" layout, state language and "Graphite" style

- Status: Accepted
- Date: 2026-10-30
- Deciders: The owner
- Requirements: FR-I18N-1, FR-ALR-1, FR-ALR-2, FR-CMD-4, FR-CMD-5, FR-DEMO-1, NFR-A11Y-1, NFR-REL-1, SEC-WEB-1

## Context

`docs/SPEC.md` §4.4 lists the console pages and their content but not their layout or visual style. It
planned a brand pass in M11. The target users work in operations rooms and on the warehouse floor, and the
reference is the visual language of SpaceX, Tesla, Apple Vision Pro and ChatGPT: dark, airy, little information at
once, glass and transparency, camera and vision at the centre, a distinctive modern typeface. A layout that looks
generated and untouched would cost credibility.

The decision was made in three rounds, each validated by the owner on interactive mock-ups:

1. Layout, with the visual style held constant.
2. Robot state language (shape, pictogram, colour), validated situation by situation.
3. Visual style (colour, typeface, HUD size) on the chosen layout.

## Decision

1. **Layout "Plan"** (Tesla in-car display): the warehouse map, tilted in perspective, fills the screen.
   At rest only a status line, an alert pill, two KPIs and a navigation dock are visible. Selecting a robot
   opens a glass side panel (live video, readouts, commands, e-stop); on phone it becomes a bottom sheet.
   Other pages open as glass sheets over the live map.
2. **State language**: 9 robot states, 8 badges, 4 alert severities with a lifecycle, 3 command results,
   3 connection states. Shape carries state (circle, rounded square, triangle, octagon, dashed), white means
   nominal, blue means a human acts, amber blocks, red stops. A sensor fault puts the robot in `BLOCKED`
   with a sensor-fault badge (the spec did not name the state).
3. **Style "Graphite"**: neutral black with a radial lift, smoked glass (55 %, blur 26 px), white accent,
   Geist and Geist Mono self-hosted, compact HUD (13 px text, 40 px controls, 44 px on touch).

Details: `docs/design/DESIGN.md`. Values: `apps/console/src/theme/tokens.ts` and `tokens.css`. State
mapping: `apps/console/src/theme/robot-state-visuals.ts`.

## Alternatives considered

Layouts:

- **"Vitre"** (Vision Pro): the real robot's camera as the permanent background with glass panels on top.
  The most spectacular, but only one robot has a camera and text over video is hard to keep legible.
- **"Mission"** (SpaceX + ChatGPT): giant numbers, the map as a band, an event timeline and a command bar.
  Very readable from afar, but the map gets the least room and the command bar is extra scope.

Styles:

- **"Nuit"**: indigo and cream, Poppins, medium HUD. Warm and recognisable, but the indigo lowers the contrast of
  the "human" state blue, and the palette depends on colours not yet confirmed.
- **"Glace"**: very transparent glass on blue night, ice accent, Sora, large HUD. The most "vitrified", but
  shows less map, its accent is close to the "human" state blue and the offline grey falls under 3:1 on its
  lightest glass.

## Consequences

- The M11 "brand pass" step is no longer needed: the style is final. Re-skinning stays possible by editing
  `tokens.ts` and `tokens.css` only.
- The robot list and filters are not visible at rest; they live in the Robots sheet and in search. The map
  must therefore have a keyboard-accessible alternative (the Robots sheet) and labelled markers.
- Markers are projected in JS onto the tilted plane so they stay upright; the projection must use the same
  tilt and perspective tokens as the CSS.
- Two new dependencies for M6: `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (OFL-1.1,
  self-hosted fonts, no third-party font request, compatible with the strict CSP).
- The `WORKING` icon is an original drawing (`RobotArmIcon`) in Lucide's grid.
