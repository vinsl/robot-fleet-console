# ADR 0056 — Workstation footprint as an optional size on the point

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-SITE-1, FR-SITE-2
- Threat: T6 (hostile or oversized site map)
- Implemented in: `packages/protocol/src/site-map.ts`, `packages/protocol/src/index.ts`,
  `packages/protocol/test/site-map.test.ts`, `packages/protocol/test/fixtures/site-map/`,
  `packages/protocol/generated/site-map.schema.json`, `services/api/test/site/validate-map.test.ts`,
  `agent/src/fleet_agent/sim/site_map.py`, `agent/tests/sim/test_site_map.py`, `docs/SPEC.md` §4.5

## Context

The operator places workstations in the site editor. A workstation is a bay of a few metres, but the map stores it
as a point, so the console draws a dot that cannot show the bay it stands for. The editor needs the bay's size to be
stored, shown and resized. The map is also the planner's input: the simulator routes robots to the workstation's
point, and version 1 maps (already saved, already validated) have point-only workstations that must stay valid.

## Decision

A workstation keeps its `Point` geometry and gains an optional `properties.size` with `width` and `height` in metres,
each between 0.1 and 50, centred on the point. Absent means a point marker, as before. The point stays the mission
target. The footprint counts for the extent limit (its four corners, not the vertex count), so a bay at the edge of
the plan cannot widen the map past the 1 000 m limit (protocol) or the 200 m limit (simulator) unseen.

The schema is strict: an extra key in `size` is refused, a non-finite side is refused by zod and pydantic, and
`size` is refused on a charger and on a no-go zone. The simulator mirrors the rule in pydantic, keeps the size as
information on `Station.size`, and does not read it in the planner, the routes or the missions.

## Alternatives considered

| Option                                         | Pros                                           | Cons                                                                                                                                                                                                                                                                                              | Why not                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Workstation as a `Polygon` (rectangle ring)    | The footprint is the geometry; no second field | Breaks every saved version 1 map (point workstations): the schema needs a union of two shapes; a polygon needs a centroid or entry-point rule in the API, the agent and the planner, with parity tests; the vertex and extent checks change; a self-intersecting ring is a new validation surface | Point plus optional size changes no consumer's semantics and keeps the planner's target a single position |
| Keep the point, no footprint                   | Nothing changes                                | The operator cannot see or set the bay's size; the editor cannot show what the robot must clear                                                                                                                                                                                                   | The feature is part of FR-SITE-1 and the editor's purpose                                                 |
| Footprint as a free-form `properties.geometry` | Any shape                                      | An unbounded, unvalidated shape to check against T6; no requirement asks for it                                                                                                                                                                                                                   | Out of scope; a rectangle is what the operator draws                                                      |

## Consequences

- Deploy order: the agent must be deployed before a map with a `size` is saved or activated. An agent that still
  runs the old schema refuses such a map with a visible `SCHEMA` error (fail closed, no value echoed). The simulator
  fleet is rebuilt by `make sim`, so the order is a single step in the demo runbook.
- The planner ignores the footprint: a robot may plan through a bay's corner, and it arrives at the point. A later
  ADR may make the arrival tolerance the footprint; that is not part of this release.
- The footprint counts for the extent, so a valid map can be 1 000 m across only when its footprints fit in it. The
  summary of a version (`extentM`) still measures vertices and points only, as before. The difference is at most
  half a footprint side at each end, and the summary is informational.
- The footprint is bounded in size, so it adds a few bytes per workstation to the 2 MB limit of a map.
- The editor (ADR 0054 wizard and the site editor) gets the footprint through the protocol type. Resizing and undo are
  decided in the editor's own slices; this ADR does not add an undo stack.
- No new endpoint, no IAM change, no new dependency, no cost change. The generated schema is regenerated and checked
  by `make check-generated`.
