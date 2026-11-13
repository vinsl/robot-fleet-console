# ADR 0058 — Fleet map: projected upright markers, 2D pan and zoom inside the tilted plane, interpolated motion

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-SITE-3, NFR-PERF-1, NFR-A11Y-1, NFR-REL-1
- Implemented in: `apps/console/src/fleet/map/projection.ts`, `apps/console/src/fleet/map/view-reducer.ts`,
  `apps/console/src/fleet/map/MarkerLayer.tsx`, `apps/console/src/fleet/map/FleetMap.tsx`,
  `apps/console/src/fleet/map/StateMarker.tsx`, `apps/console/src/fleet/map/geometry-hooks.ts`,
  `apps/console/src/live/fleet-reducer.ts` (`nextMotion`, `poseAt`)

## Context

The fleet view shows the site plan on a tilted plane, as the locked design asks (DESIGN 2.1). The robots are drawn on
that plane, but their markers must stay upright and readable, with a state shape, a glyph and a label. Robots report
a pose about once per second. Drawn as they arrive, they jump. Drawn as children of the tilted SVG, the markers would
tilt with the plane. The site map component (`SiteMapView`) is shared with the site editor and computes its own
viewBox, so it cannot be changed for the fleet view.

## Decision

- **Markers sit in an overlay outside the tilted plane.** Their screen position is computed in JavaScript with the same
  geometry as the CSS: `rotateX(tilt)` about the transform origin, then perspective about the stage centre. The maths
  (`projection.ts`) is pure, and its inverse (`unprojectToPlane`) is used for pointer anchors. A round trip is tested to
  1e-6 for a grid of points and several tilts.
- **Pan and zoom are a 2D transform of a content box inside the plane.** The content box is the fitted site plan. The
  view state (zoom, pan) is a pure reducer (`view-reducer.ts`). The tilt is read once from the tokens, and the CSS takes
  the same value from JavaScript, so there is one source.
- **Motion is interpolated, not predicted.** One `requestAnimationFrame` loop per map writes `style.transform` on each
  marker. A marker moves from the pose it is drawn at to the newest sample, over the interval observed between the last
  two samples, clamped to 250–2 500 ms. A jump over 5 m, or a new boot, snaps the marker. The loop reads no layout and
  sets no React state.
- **Heading is projected.** The heading is the screen direction of a probe point half a metre ahead on the plane.
- **Keyboard path.** Markers form a roving tab stop. Arrow keys move to the nearest marker in that direction, and Enter
  or Space open the robot. The map is `aria-hidden` apart from the marker group and the controls.

## Alternatives considered

| Option                                   | Pros                               | Cons                                                                                             | Why not                                                                 |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Markers as children of the tilted SVG    | No projection code                 | Markers tilt and foreshorten with the plane, and become hard to read at the tilt the design asks | DESIGN 2.1 (locked): upright, readable markers                          |
| Dead reckoning from speed and heading    | Smooth between samples at any rate | Overshoots at every turn, and the robot's speed is not in every sample                           | Linear interpolation to the newest sample is bounded in time and error  |
| React state per frame for positions      | Declarative                        | One re-render per marker per frame for 20 robots                                                 | Performance budget (DESIGN 4.4, 6): direct style writes in one rAF loop |
| Change `SiteMapView` to take a transform | One projection path                | Touches the site editor, which another branch owns                                               | The fleet view wraps the component unchanged                            |

## Consequences

- The projection is the one place that knows the tilt geometry. A change of tilt, perspective or origin must change the
  CSS and `projection.ts` together, and the tests catch a mismatch of the round trip.
- A marker lags its newest sample by up to 2.5 s by design. The alert and state labels still show the real state at
  once, because they come from the store, not from the drawn position.
- The rAF loop runs whenever the map is mounted. It is cancelled on unmount. Its cost is 20 style writes per frame at
  demo scale (the cap of 60 robots in the snapshot keeps it bounded).
- Heading and position are approximations on a plan drawn in metres. They are for the operator's eye, not for control.
- No cost, no new dependency, no security surface: the map reads the same frames as the rest of the console.
