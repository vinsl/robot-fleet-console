# Console design (locked)

Status: **locked on 2026-10-30** by the owner. Decision record: `docs/adr/0004-console-visual-design.md`.
Changes go through a new ADR. Tokens live in `apps/console/src/theme/tokens.ts` (source of truth) and
`apps/console/src/theme/tokens.css` (CSS variables + Tailwind theme). No hard-coded colour, font, radius,
size or duration anywhere else in `apps/console`.

The design has three locked parts:

1. **Layout "Plan"**: the warehouse map is the whole screen; everything else appears on demand.
2. **Robot state language**: 9 states, 8 badges, alert, command and connection states (28 situations).
3. **Style "Graphite"**: neutral black, smoked glass, white accent, Geist, compact HUD.

Reference mock-ups (static HTML, open in a browser, French copy): `docs/design/references/`

- `robot-states.html`: every validated state, badge, alert, command and connection visual, on the tilted map.
- `plan-styles.html`: the "Plan" layout (Fleet and Robot views) in the three candidate styles; **style 1
  "Graphite" is the chosen one**, the other two are kept for the record.

---

## 1. Principles

| Principle               | What it means in practice                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The fleet is the show   | The map fills the viewport. No permanent sidebar, no permanent list, no card grid.                                          |
| Little at once          | At rest the operator sees: status line, the map, two KPIs, the dock. Detail opens on demand and closes again.               |
| White means nominal     | A robot that drives or works is white. Colour only appears when something deserves the eye.                                 |
| Shape carries state     | Circle, rounded square, triangle, octagon, dashed outline. A state is never shown by colour alone (WCAG 1.4.1, NFR-A11Y-1). |
| Blue means a human acts | Teleoperation and pause.                                                                                                    |
| Amber blocks, red stops | Amber for blocked and major alerts, red only for e-stop, critical alerts and failures.                                      |
| Glass, not cards        | Floating surfaces are smoked glass over the map. Nothing else gets a border, fill and shadow.                               |

## 2. Layout "Plan"

Inspiration: the Tesla in-car display (the vehicle and what it sees in the centre, everything else on demand),
Apple visionOS (glass surfaces, controls as ornaments), SpaceX (big thin numbers, small uppercase labels).

### 2.1 Fleet page (desktop ≥ 1024 px)

```
┌───────────────────────────────────────────────────────────────────────┐
│ Lyon-Nord  15:31  (•) Live  10/11 online                Operator · EN │  status line (no surface)
│                 ┌──────────────────────────────────┐                  │
│                 │ ▲ Major  R-03 blocked in aisle C  12 s  [View] │    │  alert pill (glass), top centre
│                 └──────────────────────────────────┘                  │
│                                                                       │
│              warehouse map, tilted 42°, full bleed                    │
│              robots = upright markers + id label                      │
│                                                                       │
│ 96.4 %                                                            38  │  two KPIs in the bottom corners
│ AVAILABILITY       ┌─ Fleet  Alerts  KPI  Audit  Robots ─┐ MISSIONS/H │  dock (glass), bottom centre
└───────────────────────────────────────────────────────────────────────┘
```

- **Status line** (top, no surface, gradient scrim behind it): site name, clock, connection state, robots online,
  role and language switch (FR-I18N-1). The health indicator of the spec (WS state, API latency, robots online)
  lives here; API latency shows on hover/focus of the connection state.
- **Map**: SVG from the active GeoJSON (§4.5 of the spec), rendered on a plane tilted with
  `rotateX(var(--map-tilt))` and `perspective: var(--map-perspective)`. Robot markers are **not** children of the
  tilted plane: their screen position is projected in JS with the same maths so they stay upright and readable.
  Pan and zoom act on the plane. A "flat" toggle sets the tilt to 0 (needed for precise reading and for the
  Site configuration page, which is always flat).
- **Alert pill**: the newest open Critical or Major alert, top centre. "View" flies the map to the robot and
  opens its panel. More than one open alert: the pill shows the count (`3 open alerts`) and opens the Alerts sheet.
- **Dock**: main navigation, bottom centre: Fleet, Alerts (with open-alert count), KPI, Audit, Robots; Admin
  also gets Site and Users. The active item uses the accent fill.
- **KPI corners**: availability (bottom left) and missions per hour (bottom right). The full KPI strip of the
  spec is the KPI sheet.
- **Robot list and filters** are not visible at rest. They live in the "Robots" sheet and in the search
  (`/` or `Ctrl K`), which filters markers on the map (state, battery, alert).

### 2.2 Robot panel (selected robot)

Clicking a marker, a list row or "View" on an alert opens a **glass side panel on the right**
(width `--panel-w`, full height minus `--space-5` margins). The map stays live behind it and centres on the
robot, which gets the selection ring.

Panel content, top to bottom:

1. Live video (16:9, rounded `--radius-inner`), overlay `LIVE · 212 ms` top left (FR-VID-4 overlay fields:
   name, state, position, speed, latency are split between the video overlay and the readouts below).
   Simulated robots have no camera: the slot shows a zoomed flat map around the robot instead.
2. Robot id (large number style) and state chip.
3. Three readouts: speed, battery, command round-trip latency.
4. Lock line: `Control: you · expires in 28 s`, or `Claire D. has control`, or `Take control` button.
5. State timeline (last 10 min) and last command ACKs, collapsible.
6. Commands, 2 × 2 grid: Pause, Resume, Return to base, Release control.
7. **E-stop**: full-width red pill, last element, always present for Operators even without the lock
   (FR-CMD-4). Release flow: `Release e-stop` replaces it after an e-stop and asks for confirmation inside the
   panel (no browser dialog).

The Robot page of the spec (`/robots/:id`) is this panel in focused mode: same content, panel widened to
`--panel-w-focus` and the map dimmed to `--scrim-strong`. Deep links open it directly.

A toggle on the panel's left edge widens it to `--panel-w-expanded` (60vw), and a second toggle hides the video overlay
(name, state, position, speed) while the latency chip stays. Both toggles are a visual change decided in ADR 0074.

### 2.3 Other pages

All other pages open as **sheets**: a large glass surface over the dimmed map (`--scrim-strong`), centred,
max width `--sheet-max-w`, closed with Esc, the dock or the close button. The map keeps updating behind.

| Page                       | Sheet content                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alerts                     | List grouped by severity then age; each row: severity chip, robot, message, age, Acknowledge / Resolve. History tab.                                                                                                                           |
| Audit                      | Table: time, who, action, robot, result chip, correlation id (mono). Filters in the sheet header.                                                                                                                                              |
| KPI                        | Two groups by time window (ADR 0078): "This session" with availability and missions/h as hero numbers, error rate; "Last 24 h" with interventions per robot and MTTR. Units beside the numbers; warm-up and no-data states as text. No charts. |
| Robots (Admin)             | List with state chips; Register, download kit once, Retire.                                                                                                                                                                                    |
| Users (Admin)              | List with role; Create user, Disable.                                                                                                                                                                                                          |
| Site configuration (Admin) | Full-screen, map **flat**; DXF import → layer mapping → preview → place charger, stations, no-go → save version → activate.                                                                                                                    |
| Sign in                    | Centred glass card over a static, blurred map illustration. MFA step in the same card.                                                                                                                                                         |
| Demo mode (Admin)          | Toggle in the Admin menu; permanent banner while on (see §3.6).                                                                                                                                                                                |

The KPI sheet layout above amends the locked design, as recorded in ADR 0078. The sheet has two groups, by time
window; each group has a heading, and the partial notice of the alert history is shown once, in the 24-hour group.
Availability and missions per hour use the large number size of the KPI corners, the other three use the standard
size. A KPI with no data shows an em dash (hidden from assistive technology) and the text "No data yet". Missions per
hour during warm-up shows the count, the unit "in N min" and the hint "Rate shown after 5 min", where 5 is
`live.kpiWarmupMs` (ADR 0059).

### 2.4 Compact screens: phone (portrait or landscape) and tablet

A screen is compact when it is narrower than 640 px or at most 500 px high, so a phone in landscape gets the same
layout as in portrait (ADR 0075).

- Status line collapses to: site, connection icon, alert count.
- KPI corners are hidden; the numbers stay on the KPI page of the dock (ADR 0075).
- Dock stays at the bottom, icons only, labels as `aria-label`; safe-area insets respected.
- The robot side panel becomes a **bottom sheet** with two snap points (40 % and 90 % of the height). The
  e-stop stays visible at both snap points.
- Map tilt is reduced to `--map-tilt-compact`.
- Touch targets: controls use `--control-h-coarse` (44 px) when `(pointer: coarse)`.

## 3. State language (validated 2026-10-30)

Colours are tokens (`tokens.state.*`); never use the hex values directly. Icons are
[Lucide](https://lucide.dev) except the custom `RobotArmIcon`. Mapping in code:
`apps/console/src/theme/robot-state-visuals.ts`.

### 3.1 Robot states (one at a time, spec §6)

| State      | Label EN / FR            | Marker shape                      | Icon                                       | Colour token     | Extra                                 | Alert    |
| ---------- | ------------------------ | --------------------------------- | ------------------------------------------ | ---------------- | ------------------------------------- | -------- |
| `MOVING`   | Moving / En route        | Filled circle                     | `Navigation2`, rotated to heading          | `state.nominal`  | Heading arrow outside the circle      | —        |
| `WORKING`  | Working / En mission     | Filled rounded square             | `RobotArmIcon` (custom)                    | `state.nominal`  | —                                     | —        |
| `IDLE`     | Idle / Disponible        | **Hollow** circle with centre dot | dot (marker), `CircleDot` (chip)           | `state.idle`     | —                                     | —        |
| `CHARGING` | Charging / En charge     | Filled circle                     | `BatteryCharging`                          | `state.charging` | Outer ring                            | —        |
| `PAUSED`   | Paused / En pause        | Hollow circle, thick stroke       | `Pause`                                    | `state.human`    | —                                     | —        |
| `TELEOP`   | Teleop / Téléopéré       | Filled circle                     | `Hand`                                     | `state.human`    | Heading arrow + dashed outer ring     | —        |
| `BLOCKED`  | Blocked / Bloqué         | Filled triangle                   | `!` glyph (marker), `TriangleAlert` (chip) | `state.blocked`  | Pulse halo                            | Major    |
| `ESTOP`    | E-stop / Arrêt d'urgence | Filled octagon                    | `OctagonX`                                 | `state.estop`    | Pulse halo                            | Critical |
| `OFFLINE`  | Offline / Hors ligne     | Dashed hollow circle              | `WifiOff`                                  | `state.offline`  | Last known position, age label `22 s` | Major    |

Rules:

- Filled markers draw the icon in `ink` (near black); hollow markers draw it in the state colour.
- Every marker has a 2 px `ink` outline so it separates from the map and from other markers.
- Zoomed-out markers (below `--marker-detail-min-zoom`) drop the icon but keep shape, fill style, ring and
  heading arrow, so states stay distinguishable without colour.
- Id label (`R-03`) under the marker, `--text-xs`, on a `--scrim` pill.

### 3.2 Badges (cumulative, top right of the marker; stacked upwards)

| Badge          | Label EN / FR                            | Icon           | Colour token     | When                                                                         |
| -------------- | ---------------------------------------- | -------------- | ---------------- | ---------------------------------------------------------------------------- |
| Low battery    | Low battery / Batterie faible            | `BatteryLow`   | `state.blocked`  | battery < 20 % (Minor alert)                                                 |
| Sensor fault   | Sensor fault / Panne capteur             | `EyeOff`       | `state.estop`    | sensor fault event; robot shown `BLOCKED` (Major)                            |
| Control: you   | Control: you / Contrôle : toi            | `Lock`         | `state.human`    | you hold the lock                                                            |
| Control: other | `{name} has control` / `{name} contrôle` | `User`         | `text.secondary` | another operator holds the lock                                              |
| Live camera    | Live / Direct                            | `Video`        | `text.primary`   | robot has a video channel                                                    |
| Stale data     | `{n} s ago` / `il y a {n} s`             | `Clock`        | `text.secondary` | 5–15 s without message; marker at `--opacity-stale` (before OFFLINE at 15 s) |
| Simulated      | Simulated / Simulé                       | `FlaskConical` | `text.secondary` | only while demo mode is on                                                   |
| Selected       | —                                        | white ring     | `focus.ring`     | robot whose panel is open                                                    |

Badge: 15 px circle, `bg.base` fill, 1.4 px stroke and 9 px icon in the badge colour.

Open question settled by this design (recorded in the `RobotStateSchema` docstring): a **sensor fault puts the robot in
`BLOCKED`** with the sensor-fault badge (the spec does not name the state).

### 3.3 Alerts (FR-ALR-1, FR-ALR-2)

| Severity | Label EN / FR       | Icon            | Colour token     | Signal                                   |
| -------- | ------------------- | --------------- | ---------------- | ---------------------------------------- |
| Critical | Critical / Critique | `OctagonX`      | `alert.critical` | Repeated sound until acknowledged + pill |
| Major    | Major / Majeure     | `TriangleAlert` | `alert.major`    | One sound + pill                         |
| Minor    | Minor / Mineure     | `CircleAlert`   | `alert.minor`    | No sound, dock counter                   |
| Info     | Info / Info         | `Info`          | `alert.info`     | List only                                |

Lifecycle: **open** = filled chip (icon and text in `ink`); **acknowledged** = outline chip in the severity
colour, plus who and when; **resolved** = `CircleCheck` in `state.idle`, grey text, with time-to-resolve
(feeds MTTR). Sound can be muted from the status line (FR-ALR-2); muted state is remembered locally.

### 3.4 Commands (FR-CMD-5)

| Status | Icon                                                | Colour token     | Text                                                                                                                     |
| ------ | --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sent   | `LoaderCircle` (spinning, static if reduced motion) | `text.secondary` | `Pause · sending…`                                                                                                       |
| ACK    | `Check`                                             | `state.charging` | `Pause · 143 ms`                                                                                                         |
| REJECT | `X`                                                 | `state.estop`    | `Resume · invalid state` (reason translated: expired, duplicate, invalid state, not lock holder, invalid, not simulated) |

### 3.5 Connection (NFR-REL-1)

| Status       | Icon        | Colour token     | Behaviour                                                          |
| ------------ | ----------- | ---------------- | ------------------------------------------------------------------ |
| Live         | `Radio`     | `state.charging` | normal                                                             |
| Reconnecting | `RefreshCw` | `state.blocked`  | map stays visible, frozen; markers go stale                        |
| Offline      | `WifiOff`   | `state.estop`    | banner; commands disabled except e-stop while the HTTP API answers |

### 3.6 Demo mode (FR-DEMO-1)

Permanent banner across the top above the status line: `bg.raised` fill, `FlaskConical` icon, uppercase
`DEMO MODE` in `text.primary`, `Simulated faults are audited` in `text.secondary`. Neutral on purpose so it
never competes with alerts. Simulated badges become visible.

## 4. Style "Graphite"

### 4.1 Colour

| Token                                                      | Value                                             | Use                                                 |
| ---------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `bg.base`                                                  | `#050608`                                         | page background, edges of the radial gradient       |
| `bg.raised`                                                | `#16181C`                                         | centre of the radial gradient, raised flat surfaces |
| `glass.fill`                                               | `rgba(22,24,28,.55)` + blur 26 px, saturate 150 % | every floating surface                              |
| `glass.edge`                                               | `rgba(255,255,255,.12)`                           | 1 px border of glass                                |
| `glass.highlight`                                          | `rgba(255,255,255,.10)`                           | 1 px inset top highlight                            |
| `text.primary`                                             | `#F2F3F5`                                         | text, numbers                                       |
| `text.secondary`                                           | `#A3A5A8`                                         | secondary text (≥ 6.6:1 on every surface)           |
| `text.tertiary`                                            | `#8E9093`                                         | labels (≥ 5.4:1)                                    |
| `accent` / `accent.ink`                                    | `#F2F3F5` / `#0A0B0D`                             | primary button, active dock item                    |
| `ink`                                                      | `#0A0B0D`                                         | icons and text on filled colour                     |
| `state.*`, `alert.*`                                       | see §3 and `tokens.ts`                            | states only                                         |
| `estop.fill`                                               | `#D7322B` (white text 4.8:1)                      | e-stop button only                                  |
| map: `wall`, `rack`, `rackLine`, `grid`, `station`, `nogo` | white at 50 / 5 / 20 / 4.5 / 60 %, red no-go      | map drawing                                         |

Contrast was checked for every pair: text ≥ 4.5:1, markers and icons ≥ 3:1 against `bg.base`, `bg.raised`
and glass.

### 4.2 Typography

- **Geist** (variable, 100–900) for everything, **Geist Mono** for ids, correlation ids and code.
  Self-host with `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (OFL-1.1); no Google Fonts
  request (keeps the CSP strict, SEC-WEB-1).
- `font-variant-numeric: tabular-nums` on every number.
- Scale: `xs 11`, `sm 12`, `base 13`, `md 15`, `lg 18`, `xl 22`, `num 30`, `num-lg 40` (px).
- Big numbers: weight 300, letter-spacing −0.02 em. Labels: 11 px uppercase, letter-spacing 0.12 em,
  `text.tertiary`.

### 4.3 HUD size (compact)

| Token              | Value                                                |
| ------------------ | ---------------------------------------------------- |
| `--text-base`      | 13 px                                                |
| `--control-h`      | 40 px (44 px with `pointer: coarse`)                 |
| `--number`         | 30 px                                                |
| `--marker`         | 24 px body, 15 px badges                             |
| `--panel-w`        | 400 px (focus mode 560 px)                           |
| `--radius-surface` | 20 px; inner (video) 12 px; controls and chips: pill |
| spacing            | 4 px base: 4, 8, 12, 16, 24, 32, 40                  |

### 4.4 Motion

- Panels and sheets: slide/fade 220 ms, `cubic-bezier(.2,.8,.2,1)`.
- Map fly-to on "View": 400 ms, same easing.
- Robot motion between telemetry points: linear interpolation over the telemetry interval (spec §4.2).
- Pulse halo on `BLOCKED` and `ESTOP`: 1.8 s, ease-out, infinite.
- `prefers-reduced-motion: reduce`: no pulse (static halo at 50 %), no fly-to (jump), spinner replaced by a
  static icon, interpolation kept (it carries information).

## 5. Accessibility checklist (NFR-A11Y-1)

- Every marker is a button with `aria-label="R-03, Blocked, battery 54 %"`; the map has a list alternative
  (Robots sheet) reachable by keyboard.
- Tab order: status line → alert pill → map markers (arrow keys move between nearest robots) → KPI → dock.
- Focus ring: 2 px `focus.ring`, offset 2 px, on every interactive element.
- Esc closes the panel or sheet; focus returns to the element that opened it.
- No information by colour alone: shape + icon + text everywhere (marker, chip, list).
- Live regions: new Critical/Major alert and command results are announced (`aria-live="polite"`,
  `assertive` for Critical).

## 6. Implementation notes for M6–M9

- Build the primitives first: `GlassSurface`, `StateMarker`, `StateChip`, `Badge`, `AlertPill`, `Dock`,
  `SidePanel`/`BottomSheet`, `Sheet`, `EStopButton`, `BigNumber`.
- `StateMarker` takes `{ state, heading, badges, selected, detail }` and reads everything else from
  `robot-state-visuals.ts`.
- shadcn/ui components are restyled through the CSS variables in `tokens.css`; do not fork their colours.
- Markers are SVG; the map plane and markers update through `requestAnimationFrame`, not React state per frame.
- `backdrop-filter` falls back to `glass.fallback` (opaque) when unsupported or when
  `prefers-reduced-transparency: reduce`.
