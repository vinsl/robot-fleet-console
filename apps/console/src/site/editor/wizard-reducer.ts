/**
 * State machine of the site configuration wizard: pick a drawing, map its layers, then edit the plan.
 *
 * The reducer is pure, so every transition is tested without a DOM. The state lives in the site page rather than in
 * the components, so a locale switch or a change of tab keeps the work, and the page can ask whether a draft would
 * be lost before it closes. Saving does not add a step: it is a status of the editor, and a saved draft ends in
 * the `done` status, which replaces the editor.
 *
 * Going back from the editor to the mapping keeps the placed features as long as the plan keeps its origin;
 * a different origin would move every feature, so the features are then dropped on the next confirmation.
 */
import { MAX_EXTENT_M, type MapVersion } from "@mfc/protocol";
import {
  DEFAULT_WORKSTATION_SIZE_M,
  importGeometry,
  type EditorFeatures,
  type Imported,
  type Rect,
  type Size,
} from "../dxf/build-site-map";
import { suggestMapping, type LayerMapping, type LayerRole } from "../dxf/layer-mapping";
import { metresPerUnit as metresPerUnitOf } from "../dxf/units";
import type { DxfDocument, Point } from "../dxf/types";
import { EMPTY_FEATURES, type FeatureRef } from "./draft";
import {
  fitRect,
  growRect,
  limitsFor,
  resizeRect,
  sameRect,
  withWorkstationRect,
  workstationRect,
  type Handle,
  type Limits,
} from "./shapes";
import type { SaveFailure } from "./save-map";

/** Steps of the wizard, in order. */
type WizardStep = "pick" | "mapping" | "edit";

/** Tools of the editor. The pointer and the keys act with the current tool. */
export type Tool = "select" | "charger" | "workstation" | "nogo";

/**
 * A failure the wizard shows next to the step it happened in. Parse failures are shown by the pick step itself.
 * `extent` is refused at confirmation, before the editor, because a plan larger than the protocol allows
 * cannot be saved whatever the operator places.
 */
export type WizardError = "scale" | "extent";

/**
 * Progress of the save. `saving` is set before the first request, so a second save is refused while one runs.
 * A `failed` status keeps the failure, which says whether a reserved version can be validated again.
 */
export type SaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly failure: SaveFailure }
  | { readonly kind: "done"; readonly version: MapVersion };

/** A shape the editor resizes: a workstation footprint or a no-go zone. */
export type ShapeRef = Extract<FeatureRef, { readonly kind: "workstation" | "nogo" }>;

/** Everything the wizard knows. */
export interface WizardState {
  /** The step on screen. */
  readonly step: WizardStep;
  /** The parsed drawing, or `null` before a file is picked. */
  readonly doc: DxfDocument | null;
  /** The role of each layer, by layer name. */
  readonly mapping: LayerMapping;
  /** Metres per drawing unit, or `null` when the header does not give one and the operator has not typed it. */
  readonly metresPerUnit: number | null;
  /** The imported geometry, set once the mapping is confirmed. */
  readonly imported: Imported | null;
  /** The features placed in the editor. */
  readonly editor: EditorFeatures;
  /** The current editor tool. */
  readonly tool: Tool;
  /** The feature selected in the editor, if any. */
  readonly selection: FeatureRef | null;
  /** The failure to show, if any. */
  readonly error: WizardError | null;
  /** Progress of the save of the draft. */
  readonly save: SaveStatus;
}

/** Every change the wizard accepts. */
export type WizardAction =
  | { readonly type: "parsed"; readonly doc: DxfDocument }
  | { readonly type: "setRole"; readonly layer: string; readonly role: LayerRole }
  | { readonly type: "setScale"; readonly scale: number | null }
  | { readonly type: "confirmMapping" }
  | { readonly type: "back" }
  | { readonly type: "setTool"; readonly tool: Tool }
  | { readonly type: "select"; readonly target: FeatureRef | null }
  | { readonly type: "placeCharger"; readonly at: Point }
  | { readonly type: "addWorkstation"; readonly at: Point }
  | { readonly type: "renameWorkstation"; readonly index: number; readonly name: string }
  | { readonly type: "setWorkstationAt"; readonly index: number; readonly at: Point }
  | { readonly type: "setWorkstationSize"; readonly index: number; readonly size: Size }
  | {
      readonly type: "resizeTo";
      readonly target: ShapeRef;
      readonly handle: Handle;
      readonly to: Point;
    }
  | {
      readonly type: "resizeBy";
      readonly target: ShapeRef;
      readonly dw: number;
      readonly dh: number;
    }
  | { readonly type: "setShape"; readonly target: ShapeRef; readonly rect: Rect }
  | { readonly type: "restoreShape"; readonly target: ShapeRef; readonly rect: Rect }
  | { readonly type: "addNogo"; readonly rect: Rect }
  | { readonly type: "updateNogo"; readonly index: number; readonly rect: Rect }
  | {
      readonly type: "moveBy";
      readonly target: FeatureRef;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly type: "remove"; readonly target: FeatureRef }
  | { readonly type: "saveStarted" }
  | { readonly type: "saveFailed"; readonly failure: SaveFailure }
  | { readonly type: "saved"; readonly version: MapVersion }
  | { readonly type: "reset" };

/** The state before any file is picked. */
export const INITIAL_WIZARD_STATE: WizardState = {
  step: "pick",
  doc: null,
  mapping: {},
  metresPerUnit: null,
  imported: null,
  editor: EMPTY_FEATURES,
  tool: "select",
  selection: null,
  error: null,
  save: { kind: "idle" },
};

/**
 * Tells whether the operator would lose work by closing the site page: a drawing is loaded and its draft has not
 * been saved. A saved draft has nothing left to lose.
 *
 * @param state - The current state.
 * @returns `true` when closing the page discards a draft.
 */
export function hasUnsavedDraft(state: WizardState): boolean {
  return state.doc !== null && state.save.kind !== "done";
}

/**
 * Tells whether a scale is a positive, finite number of metres per unit.
 *
 * @param scale - The candidate scale, or `null` when none is given.
 * @returns `true` when the scale can be used.
 */
export function isUsableScale(scale: number | null): scale is number {
  return scale !== null && Number.isFinite(scale) && scale > 0;
}

/**
 * Name of the next workstation: `ws-NN`, with the first number not used yet.
 *
 * @param names - Names already in use.
 * @returns A name that follows the protocol grammar.
 */
export function nextWorkstationName(names: readonly string[]): string {
  const used = new Set(names);
  for (let number = 1; ; number += 1) {
    const name = `ws-${number.toString().padStart(2, "0")}`;
    if (!used.has(name)) {
      return name;
    }
  }
}

/**
 * Puts a rectangle in normal form: its corner is the lower-left one, and its sides are positive. A drag can go
 * in any direction, and the stored form does not depend on it.
 *
 * @param rect - The rectangle as drawn.
 * @returns The normalised rectangle.
 */
export function normaliseRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.w),
    y: Math.min(rect.y, rect.y + rect.h),
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
}

/**
 * Returns a copy of a list with one element replaced, or removed when `replacement` is `null`.
 *
 * @param list - The list.
 * @param index - Index of the element.
 * @param replacement - The new element, or `null` to remove it.
 * @returns The new list.
 */
function replaceAt<T>(list: readonly T[], index: number, replacement: T | null): T[] {
  const out: T[] = [];
  list.forEach((item, position) => {
    if (position !== index) {
      out.push(item);
    } else if (replacement !== null) {
      out.push(replacement);
    }
  });
  return out;
}

/**
 * Applies a change to the wizard state. Pure: the same state and action always give the same state.
 *
 * @param state - The current state.
 * @param action - The change.
 * @returns The next state.
 */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "parsed":
      return {
        ...INITIAL_WIZARD_STATE,
        step: "mapping",
        doc: action.doc,
        mapping: suggestMapping(action.doc.layers),
        metresPerUnit: metresPerUnitOf(action.doc.insUnits),
      };

    case "setRole":
      return {
        ...state,
        // Rebuilt from the entries, so a layer named like an object property cannot reach the prototype.
        mapping: Object.fromEntries(
          Object.entries(state.mapping).map(([name, role]) => [
            name,
            name === action.layer ? action.role : role,
          ]),
        ),
      };

    case "setScale":
      return { ...state, metresPerUnit: action.scale, error: null };

    case "confirmMapping": {
      if (state.doc === null) {
        return state;
      }
      if (!isUsableScale(state.metresPerUnit)) {
        return { ...state, error: "scale" };
      }
      const imported = importGeometry({
        doc: state.doc,
        mapping: state.mapping,
        metresPerUnit: state.metresPerUnit,
      });
      if (imported.extent[0] > MAX_EXTENT_M || imported.extent[1] > MAX_EXTENT_M) {
        return { ...state, error: "extent" };
      }
      // The features are stored in the plan frame; a new origin moves the plan under them, so they are dropped.
      const sameFrame =
        state.imported !== null &&
        state.imported.originShift[0] === imported.originShift[0] &&
        state.imported.originShift[1] === imported.originShift[1];
      return {
        ...state,
        step: "edit",
        imported,
        editor: sameFrame ? state.editor : EMPTY_FEATURES,
        tool: "select",
        selection: null,
        error: null,
      };
    }

    case "back":
      if (state.step === "edit") {
        return { ...state, step: "mapping", selection: null };
      }
      if (state.step === "mapping") {
        // A new file starts from nothing: the placed features belong to the drawing that was picked before.
        return INITIAL_WIZARD_STATE;
      }
      return state;

    case "setTool":
      return { ...state, tool: action.tool, selection: null };

    case "select":
      return { ...state, selection: action.target };

    case "placeCharger":
      return {
        ...state,
        editor: { ...state.editor, charger: action.at },
        selection: { kind: "charger" },
      };

    case "addWorkstation": {
      const name = nextWorkstationName(state.editor.workstations.map((station) => station.name));
      const index = state.editor.workstations.length;
      return {
        ...state,
        editor: {
          ...state.editor,
          workstations: [
            ...state.editor.workstations,
            {
              name,
              at: action.at,
              size: { width: DEFAULT_WORKSTATION_SIZE_M, height: DEFAULT_WORKSTATION_SIZE_M },
            },
          ],
        },
        selection: { kind: "workstation", index },
      };
    }

    case "renameWorkstation": {
      const current = state.editor.workstations[action.index];
      if (current === undefined) {
        return state;
      }
      return {
        ...state,
        editor: {
          ...state.editor,
          workstations: replaceAt(state.editor.workstations, action.index, {
            ...current,
            name: action.name,
          }),
        },
      };
    }

    case "setWorkstationAt": {
      const current = state.editor.workstations[action.index];
      if (current === undefined) {
        return state;
      }
      return {
        ...state,
        editor: {
          ...state.editor,
          workstations: replaceAt(state.editor.workstations, action.index, {
            ...current,
            at: action.at,
          }),
        },
      };
    }

    case "setWorkstationSize": {
      const current = state.editor.workstations[action.index];
      if (current === undefined) {
        return state;
      }
      // Stored as typed, like a no-go zone: the draft reports a size out of range, it is not corrected here.
      if (current.size.width === action.size.width && current.size.height === action.size.height) {
        return state;
      }
      return {
        ...state,
        editor: {
          ...state.editor,
          workstations: replaceAt(state.editor.workstations, action.index, {
            ...current,
            size: action.size,
          }),
        },
      };
    }

    case "resizeTo":
      return reshape(state, action.target, (rect, limits) =>
        resizeRect(rect, action.handle, action.to, limits),
      );

    case "resizeBy":
      return reshape(state, action.target, (rect, limits) =>
        growRect(rect, action.dw, action.dh, limits),
      );

    case "setShape":
      return reshape(state, action.target, (_current, limits) => fitRect(action.rect, limits));

    // A shape goes back to the footprint it was stored with, untouched: a typed size below the minimum or a
    // footprint over the plan edge must survive a cancelled drag, so the limits are not applied here.
    case "restoreShape":
      return reshape(state, action.target, () => action.rect);

    case "addNogo": {
      const rect = normaliseRect(action.rect);
      // A drag with no area is a click, not a zone.
      if (rect.w <= 0 || rect.h <= 0) {
        return state;
      }
      return {
        ...state,
        editor: { ...state.editor, nogo: [...state.editor.nogo, rect] },
        selection: { kind: "nogo", index: state.editor.nogo.length },
      };
    }

    case "updateNogo":
      if (state.editor.nogo[action.index] === undefined) {
        return state;
      }
      // Stored as typed: a value the operator enters is checked by the draft, not silently corrected here.
      return {
        ...state,
        editor: { ...state.editor, nogo: replaceAt(state.editor.nogo, action.index, action.rect) },
      };

    case "moveBy":
      return moveFeature(state, action.target, action.dx, action.dy);

    case "remove":
      return removeFeature(state, action.target);

    case "saveStarted":
      return state.save.kind === "saving" ? state : { ...state, save: { kind: "saving" } };

    case "saveFailed":
      return { ...state, save: { kind: "failed", failure: action.failure } };

    case "saved":
      return { ...state, save: { kind: "done", version: action.version }, selection: null };

    case "reset":
      return INITIAL_WIZARD_STATE;
  }
}

/**
 * Changes the rectangle of one shape. The change receives the current rectangle and the limits of the shape's kind,
 * which are read from the imported plan, so every resize respects the plan. A change that leaves the rectangle as it
 * was returns the same state, so a repeated action does not re-render.
 *
 * @param state - The current state.
 * @param target - The shape to change.
 * @param change - Computes the new rectangle from the current one and the limits.
 * @returns The next state; unchanged when the shape does not exist or the rectangle does not change.
 */
function reshape(
  state: WizardState,
  target: ShapeRef,
  change: (current: Rect, limits: Limits) => Rect,
): WizardState {
  const limits = limitsFor(target.kind, state.imported?.extent ?? null);
  if (target.kind === "workstation") {
    const current = state.editor.workstations[target.index];
    if (current === undefined) {
      return state;
    }
    const before = workstationRect(current);
    const after = change(before, limits);
    if (sameRect(before, after)) {
      return state;
    }
    return {
      ...state,
      editor: {
        ...state.editor,
        workstations: replaceAt(
          state.editor.workstations,
          target.index,
          withWorkstationRect(current, after),
        ),
      },
    };
  }
  const current = state.editor.nogo[target.index];
  if (current === undefined) {
    return state;
  }
  const after = change(current, limits);
  if (sameRect(current, after)) {
    return state;
  }
  return {
    ...state,
    editor: { ...state.editor, nogo: replaceAt(state.editor.nogo, target.index, after) },
  };
}

/**
 * Moves one feature by an offset. A no-go zone moves by its corner.
 *
 * @param state - The current state.
 * @param target - The feature to move.
 * @param dx - Offset along x, in metres.
 * @param dy - Offset along y, in metres.
 * @returns The next state; unchanged when the feature does not exist.
 */
function moveFeature(state: WizardState, target: FeatureRef, dx: number, dy: number): WizardState {
  switch (target.kind) {
    case "charger": {
      const at = state.editor.charger;
      if (at === null) {
        return state;
      }
      return { ...state, editor: { ...state.editor, charger: [at[0] + dx, at[1] + dy] } };
    }
    case "workstation": {
      const current = state.editor.workstations[target.index];
      if (current === undefined) {
        return state;
      }
      const at: Point = [current.at[0] + dx, current.at[1] + dy];
      return wizardReducer(state, { type: "setWorkstationAt", index: target.index, at });
    }
    case "nogo": {
      const current = state.editor.nogo[target.index];
      if (current === undefined) {
        return state;
      }
      return wizardReducer(state, {
        type: "updateNogo",
        index: target.index,
        rect: { ...current, x: current.x + dx, y: current.y + dy },
      });
    }
  }
}

/**
 * Removes one feature. The selection is cleared, since the indices after it would now point elsewhere.
 *
 * @param state - The current state.
 * @param target - The feature to remove.
 * @returns The next state.
 */
function removeFeature(state: WizardState, target: FeatureRef): WizardState {
  switch (target.kind) {
    case "charger":
      return { ...state, editor: { ...state.editor, charger: null }, selection: null };
    case "workstation":
      return {
        ...state,
        editor: {
          ...state.editor,
          workstations: replaceAt(state.editor.workstations, target.index, null),
        },
        selection: null,
      };
    case "nogo":
      return {
        ...state,
        editor: { ...state.editor, nogo: replaceAt(state.editor.nogo, target.index, null) },
        selection: null,
      };
  }
}
