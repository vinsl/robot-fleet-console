# ADR 0054 — Site configuration: pure wizard reducer, derived draft, and two-step activation

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-SITE-1, FR-SITE-2, FR-SITE-3, SPEC §4.5
- Threats: T6 (hostile drawing, forged or oversized map), T10 (map read across sites)
- Implemented in M7 (console): `apps/console/src/site/editor/` (`wizard-reducer.ts`, `draft.ts`, `save-map.ts`,
  `use-save-map.ts`), `apps/console/src/site/versions/VersionsTab.tsx`, `apps/console/src/pages/SitePage.tsx`

## Context

The site sheet is a three-step wizard (pick a drawing, map its layers, place the features) with a save that makes three
network calls, and a version list where an Admin validates, activates or downloads a map. The work must survive a change
of locale and a change of tab, the operator must be warned before a draft is lost, and a failed save must say at which
step it failed. A version that is uploaded but not validated must not be lost. The protocol refuses an incomplete plan,
so a draft is not a site map until it is complete.

## Decision

- **Wizard state is a pure reducer.** `wizardReducer(state, action)` in `wizard-reducer.ts` holds every transition. The
  state lives in `SitePage`, not in the step components, so a tab change keeps it, and the page asks through
  `hasUnsavedDraft` before it closes. The steps are `pick`, `mapping` and `edit`. Saving is a status (`saving`, `failed`,
  `done`), not a step; a saved draft ends in `done`, which replaces the editor.
- **The draft is derived, not stored.** `draftIssues` and `draftLayers` are computed from the features placed so far.
  `buildDraftMap` runs the protocol schema on a complete draft (version 1 as a placeholder) and returns `null` when the
  protocol refuses it. The check only shortens the feedback loop; the server remains the authority.
- **Save is three requests, in a fixed order.** `saveMapVersion` (1) checks the draft against the protocol, before any
  version is reserved, so a refused plan costs no slot; (2) reserves the version (`createMap`, which returns the version
  number and a presigned POST); (3) builds the map with that number, checks its size against 2 MB, and uploads it to the
  presigned POST; (4) validates the version, which moves it from `PENDING` to `VALID`. Each stage has its own failure
  (`SaveFailure`: stage, reason, reserved version), and a failure after the reservation keeps the version number, so a
  validation can be retried without a new upload. The hook is single-flight with a ref, so two clicks in one frame cannot
  start two saves.
- **Activation is a second, separate action.** A save never activates the version. The Versions tab asks for a
  confirmation press before it sends an activation of a `VALID` version that is not active. The panel shown after a save
  offers one button that activates the version just saved, without that confirmation. The API answers `409` when the
  version cannot be activated as it stands; the UI shows a fixed message for that case and for any other failure.

## Alternatives considered

| Option                                              | Pros                                    | Cons                                                                                                                              | Why not                                                                               |
| --------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| State in each step component (`useState`)           | No reducer to write                     | Lost on a tab change or a locale switch; the discard guard cannot read it; transitions are tested only through the DOM            | The guard and the tests both need the state outside the components                    |
| A state-machine library (XState)                    | Explicit states and guards in one place | A dependency for three steps and four save states; the reducer already makes every transition a plain function                    | Not worth a dependency for this size; the reducer gives the same checks in plain code |
| Global store (Zustand) for the wizard               | Survives navigation                     | Keeps a drawing in memory after the page closes, outside the guard                                                                | The wizard should end with the sheet; only the server keeps a version                 |
| Server-side draft (saved in DynamoDB between steps) | Work survives a reload                  | A new endpoint, a table and a cost for work that is short; the DXF must not leave the browser (ADR 0017), so the draft is GeoJSON | Reload loses the draft, which the discard guard states before it happens              |
| Activate on save                                    | One click                               | An Admin cannot compare the new version with the active one first; a mistake changes the map every robot uses                     | The activation changes the map of the whole site; it needs its own confirmation       |

## Consequences

- Every transition is a pure function with tests (`wizard-reducer.test.ts`, `wizard-save.test.ts`, `draft.test.ts`), and
  the order and failures of the save are tested without a network (`save-map.test.ts`).
- Closing the sheet asks before an unsaved draft is dropped. A page reload or a closed tab is not guarded (there is no
  `beforeunload` handler), so the draft is lost and the operator redoes the import.
- A version reserved and uploaded but not validated stays `PENDING`. It is listed in the Versions tab, where the operator
  validates it again; nothing retries it on its own, because a presigned POST is single use and expires.
- A draft the client accepts can still be refused by the server. That refusal is shown at the `validate` stage.
- Going back from the editor keeps the placed features only while the origin of the plan is the same; a new origin drops
  them on the next confirmation, so no feature is placed on a moved plan.
- Cost: one reserved version number per save attempt that passed the client check, and one object per successful upload.
