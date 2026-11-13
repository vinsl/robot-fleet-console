# ADR 0059 — KPIs computed in the console in M8, with session windows where the history is missing

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-KPI-1 (partially, see the scope note below), FR-ALR-2
- Implemented in: `apps/console/src/kpi/kpi.ts`, `apps/console/src/kpi/use-kpis.ts`, `apps/console/src/kpi/KpiCorners.tsx`,
  `apps/console/src/kpi/KpiSheet.tsx`, `apps/console/test/kpi/kpi.test.ts`
- Deferred: the `kpi` Lambda that reads `MISSION` items (SPEC 4.3), bonus in M10

## Context

FR-KPI-1 asks for KPIs "from DynamoDB", and SPEC 4.3 lists a `kpi` Lambda. M8 asks only for KPI corners and a KPI
sheet. Mission completions are stored as `MISSION` items, but no route reads them, and a new backend would add a
function, a route, IAM and a test set for a number that the console can already compute from its live stream and the
alert history. The console opened in the last minutes has no hour of history, so an hourly rate has to be labelled as
a session value.

## Decision

The KPIs are pure functions in `kpi/kpi.ts`. Each takes the live fleet, the clock, the connection state and the alert
lists, and returns a value or `null` when it cannot be computed yet. The definitions:

| KPI                     | Definition                                                                                                      | Window                  | `null` when                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| Availability            | known robots whose displayed state is not OFFLINE, BLOCKED or ESTOP, over known robots                          | now                     | no robot known, or the connection is closed |
| Missions per hour       | `MISSION` completions seen in the session (`WORK_DONE` to IDLE), over the shorter of 60 min and the session age | session                 | before `kpiWarmupMs` (5 min) of session     |
| Error rate              | stops (BLOCKED or ESTOP entries) / (missions + stops)                                                           | same window as missions | no event in the window                      |
| Interventions per robot | alerts acknowledged in the last 24 h / **robots currently known**                                               | 24 h                    | no robot known                              |
| MTTR                    | mean of (resolvedAt − openedAt) over alerts resolved in the last 24 h                                           | 24 h                    | no resolved alert in the window             |

Alerts are de-duplicated by `alertId` across the active and resolved lists. The resolved list is read on its first page
only (50 alerts). When the list has a next page, the interventions and MTTR values show the "alert history incomplete"
note.

The interventions denominator is the number of robots the console currently knows (the live fleet), not the number
registered in the fleet table. A robot that has never reported is not counted, so the value can be high on a small
live fleet. The label of the KPI says "per robot", and the README states the denominator.

The session window restarts when the console reloads, because the session log lives in memory (SPEC: no token and no
state in storage except the two preferences). The KPI sheet names the window of each value.

## Alternatives considered

| Option                                                     | Pros                                           | Cons                                                                                                                                       | Why not                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `kpi` Lambda reading `MISSION` items and the alert history | Hourly values after a reload, the spec's shape | A new function, route, role row, throttle, IAM and tests in a milestone that already has the alerts API; reads of the whole site partition | Scope (the design asks for corners and a sheet, not a backend); the console value is enough for the demo |
| Store the session log in `localStorage`                    | Survives a reload                              | Keeps operational data in the browser; the window is still partial                                                                         | Only preferences are stored in the browser                                                               |
| Hide the KPIs until a full hour is available               | No partial value                               | The corners are empty for the whole demo                                                                                                   | The labelled session window is honest and shows the value at once                                        |

## Consequences

- The values are local to the console tab. Two consoles can show different missions per hour, and that is expected.
- After a reload the missions and error rate restart, and the sheet says "Since <time>". The hourly form is a bonus.
- The KPI computation has no cost and no IAM change. It reads the same frames and the same alert queries as the rest of
  the console.
- The KPI definitions are in one file and tested by example (`kpi.test.ts`). A change to a definition is a change to
  this ADR and to the README table.
- The availability figure counts a silent robot as OFFLINE only while the connection is open (ADR 0057). KPIs do not
  count a robot silent during a gap as OFFLINE. R46 remains open for a robot that stops while connected.
