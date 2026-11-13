# ADR 0078 — KPI sheet: two time windows and hero numbers (amends the locked design, ADR 0004)

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-KPI-1, NFR-A11Y-1

## Context

The KPI sheet (bonus B, the "KPI page" of the dock) shows its five KPIs as one flat grid of equal cards. Two of the
values cover the time since the console opened (availability is instantaneous, missions per hour and the error rate
cover the session), and two cover the last 24 hours (interventions per robot and MTTR, ADR 0059). A reader cannot tell
which window a number belongs to, and nothing tells the eye which numbers matter most. Units are bare: the percentage
sign is part of the value text and the missions rate has no unit. Before the warm-up window ends, the missions card
shows a count with no hint of when the rate will appear.

The sheet is a screenshot for the report, so its reading order matters more than its density. The console computes the
KPIs from its live stream and the alert history (ADR 0059); no new data is needed for this change.

The design of the sheet is locked in `docs/design/DESIGN.md` (ADR 0004). This decision changes it, so it is recorded
here, and DESIGN.md points to it.

## Decision

The KPI sheet keeps the same five KPIs, with the same definitions, and changes the layout and the wording:

1. **Two groups by time window.** Each group has a heading and an optional note.
   - "This session, since {{time}}": availability, missions per hour, error rate.
   - "Last 24 h": interventions per robot, MTTR.
     The `partial` notice of the alert history (ADR 0059) is shown once, in the note of the 24-hour group.
2. **Hero numbers.** Availability and missions per hour use the large number size of the KPI corners (`--number-lg`).
   The other three use `--number`. The order follows FR-KPI-1.
3. **Units.** The unit is a separate element in secondary text (`--text-md`): `%` for the percentages, `/h` for the
   missions rate. The number formatting uses `Intl.NumberFormat` parts, so the French locale gets no space before the
   unit. MTTR keeps its duration format.
4. **Empty and warming states.** A KPI with no data shows an em dash (hidden from assistive technology) and the visible
   line "No data yet", styled like the partial notice. Missions per hour during warm-up shows the count with the unit
   "in N min", and the hint "Rate shown after 5 min", where 5 is `live.kpiWarmupMs` (300 000 ms, ADR 0059).
5. No chart and no new data. Compact screens keep the ADR 0075 query and use smaller padding and gaps.

Every string goes through i18n (en and fr), and no state is shown by colour alone.

## Alternatives considered

| Option                           | Pros                           | Cons                                                                                    | Why not                                                                                 |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sparkline on each KPI            | Shows the trend at a glance    | The client holds no history of the KPIs; a series would need a new store or a new route | The data does not exist in the client, and charts are out of scope (DESIGN.md, KPI row) |
| Keep the flat grid of five cards | No change to the locked design | Mixes two windows without saying so; no order of importance; bare units                 | The sheet is a report screenshot and must read in one pass                              |
| A separate page per time window  | Each page is short             | More routes and tests for five numbers; the sheet is one screen                         | Too much work for a bonus of one hour, and it hides the 24-hour values behind a click   |

## Consequences

- The locked design of the KPI sheet changes. DESIGN.md is updated in the same PR, and this ADR is the record of the
  change. Other parts of the design (KPI corners, compact layout) are unchanged.
- The KPI sheet gets two i18n groups and a unit element. The `window.*` strings are removed, so the en and fr files stay
  in step.
- The warm-up hint reads the constant, so a change of `kpiWarmupMs` changes the text too. The hint must not hard-code
  the minutes.
- The KPI screenshot for the report must be taken after the fleet has run for 15 minutes, so the missions rate is shown
  and the figures are a real run, not the warm-up. The live test notes say so.
- No security impact: the change is presentation only, and no route, role or data source changes.
- The change needs a review of the screenshot, because the locked design is only amended for this sheet.
