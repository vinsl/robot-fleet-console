/**
 * Wizard state machine: each step, each transition, and the rules that keep the features in their frame.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSTATION_SIZE_M } from "../../../src/site/dxf/build-site-map";
import { draftIssues } from "../../../src/site/editor/draft";
import {
  INITIAL_WIZARD_STATE,
  nextWorkstationName,
  normaliseRect,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "../../../src/site/editor/wizard-reducer";
import { workstationRect } from "../../../src/site/editor/shapes";
import { SMALL_DOC } from "./support";

/**
 * Applies a sequence of actions from a state.
 *
 * @param start - The starting state.
 * @param actions - The actions, in order.
 * @returns The final state.
 */
function run(start: WizardState, ...actions: Parameters<typeof wizardReducer>[1][]): WizardState {
  return actions.reduce((state, action) => wizardReducer(state, action), start);
}

/** A state with the drawing picked and its mapping confirmed, ready for the editor. */
function inEditor(): WizardState {
  return run(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC }, { type: "confirmMapping" });
}

describe("picking and mapping", () => {
  it("moves to the mapping with the suggested roles and the header scale", () => {
    const state = run(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC });
    expect(state.step).toBe("mapping");
    expect(state.mapping).toEqual({ WALLS: "wall", RACKS: "obstacle", TEXT: "ignore" });
    expect(state.metresPerUnit).toBe(0.001);
  });

  it("leaves the scale empty when the header has no unit", () => {
    const state = run(INITIAL_WIZARD_STATE, {
      type: "parsed",
      doc: { ...SMALL_DOC, insUnits: null },
    });
    expect(state.metresPerUnit).toBeNull();
  });

  it("changes the role of one layer only", () => {
    const state = run(
      INITIAL_WIZARD_STATE,
      { type: "parsed", doc: SMALL_DOC },
      { type: "setRole", layer: "TEXT", role: "wall" },
    );
    expect(state.mapping).toEqual({ WALLS: "wall", RACKS: "obstacle", TEXT: "wall" });
  });

  it("refuses to confirm the mapping without a usable scale", () => {
    for (const scale of [0, -2, Number.NaN, null]) {
      const state = run(
        INITIAL_WIZARD_STATE,
        { type: "parsed", doc: SMALL_DOC },
        { type: "setScale", scale },
        { type: "confirmMapping" },
      );
      expect(state.step, String(scale)).toBe("mapping");
      expect(state.error, String(scale)).toBe("scale");
    }
  });

  it("imports the geometry in metres once the mapping is confirmed", () => {
    const state = inEditor();
    expect(state.step).toBe("edit");
    expect(state.imported?.walls).toEqual([
      [
        [0, 0],
        [10, 0],
      ],
    ]);
    expect(state.imported?.obstacles).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  it("keeps the picked drawing when going back from the editor to the mapping", () => {
    const state = run(inEditor(), { type: "back" });
    expect(state.step).toBe("mapping");
    expect(state.doc).toBe(SMALL_DOC);
  });

  it("starts from nothing when going back from the mapping to the pick step", () => {
    const state = run(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC }, { type: "back" });
    expect(state).toEqual(INITIAL_WIZARD_STATE);
  });

  it("does nothing on back from the pick step", () => {
    expect(wizardReducer(INITIAL_WIZARD_STATE, { type: "back" })).toBe(INITIAL_WIZARD_STATE);
  });
});

describe("editing features", () => {
  it("places exactly one charger: a second placement replaces the first", () => {
    const state = run(
      inEditor(),
      { type: "placeCharger", at: [1, 1] },
      { type: "placeCharger", at: [2, 2] },
    );
    expect(state.editor.charger).toEqual([2, 2]);
    expect(state.selection).toEqual({ kind: "charger" });
  });

  it("names workstations with the first free number", () => {
    const state = run(
      inEditor(),
      { type: "addWorkstation", at: [1, 1] },
      { type: "addWorkstation", at: [2, 1] },
      { type: "renameWorkstation", index: 0, name: "ws-02" },
      { type: "addWorkstation", at: [3, 1] },
    );
    expect(state.editor.workstations.map((station) => station.name)).toEqual([
      "ws-02",
      "ws-02",
      "ws-01",
    ]);
  });

  it("selects the new workstation when it is added", () => {
    const state = run(inEditor(), { type: "addWorkstation", at: [1, 1] });
    expect(state.selection).toEqual({ kind: "workstation", index: 0 });
  });

  it("normalises a drag in any direction into a positive rectangle", () => {
    expect(normaliseRect({ x: 5, y: 4, w: -3, h: -2 })).toEqual({ x: 2, y: 2, w: 3, h: 2 });
    const state = run(inEditor(), { type: "addNogo", rect: { x: 5, y: 4, w: -3, h: -2 } });
    expect(state.editor.nogo).toEqual([{ x: 2, y: 2, w: 3, h: 2 }]);
  });

  it("ignores a no-go drag with no area", () => {
    const before = inEditor();
    expect(wizardReducer(before, { type: "addNogo", rect: { x: 1, y: 1, w: 0, h: 2 } })).toBe(
      before,
    );
  });

  it("moves a feature by an offset, and a no-go zone by its corner", () => {
    const state = run(
      inEditor(),
      { type: "placeCharger", at: [1, 1] },
      { type: "addWorkstation", at: [2, 2] },
      { type: "addNogo", rect: { x: 4, y: 4, w: 1, h: 1 } },
      { type: "moveBy", target: { kind: "charger" }, dx: 0.1, dy: -0.1 },
      { type: "moveBy", target: { kind: "workstation", index: 0 }, dx: 1, dy: 0 },
      { type: "moveBy", target: { kind: "nogo", index: 0 }, dx: 0, dy: 2 },
    );
    expect(state.editor.charger?.[0]).toBeCloseTo(1.1);
    expect(state.editor.charger?.[1]).toBeCloseTo(0.9);
    expect(state.editor.workstations[0]?.at).toEqual([3, 2]);
    expect(state.editor.nogo[0]).toEqual({ x: 4, y: 6, w: 1, h: 1 });
  });

  it("removes a feature and clears the selection", () => {
    const state = run(
      inEditor(),
      { type: "addWorkstation", at: [1, 1] },
      { type: "addWorkstation", at: [2, 2] },
      { type: "remove", target: { kind: "workstation", index: 0 } },
    );
    expect(state.editor.workstations.map((station) => station.name)).toEqual(["ws-02"]);
    expect(state.selection).toBeNull();
  });

  it("keeps the features when the plan keeps its origin, and drops them when it moves", () => {
    const placed = run(inEditor(), { type: "placeCharger", at: [1, 1] });
    const sameOrigin = run(placed, { type: "back" }, { type: "confirmMapping" });
    expect(sameOrigin.editor.charger).toEqual([1, 1]);

    const moved = run(
      placed,
      { type: "back" },
      // Without the walls the plan starts at the rack, so the origin moves.
      { type: "setRole", layer: "WALLS", role: "ignore" },
      { type: "confirmMapping" },
    );
    expect(moved.imported?.originShift).not.toEqual(placed.imported?.originShift);
    expect(moved.editor.charger).toBeNull();
  });

  it("changes the tool and clears the selection", () => {
    const state = run(
      inEditor(),
      { type: "placeCharger", at: [1, 1] },
      { type: "setTool", tool: "nogo" },
    );
    expect(state.tool).toBe("nogo");
    expect(state.selection).toBeNull();
  });
});

describe("nextWorkstationName", () => {
  it("returns the first free two-digit name", () => {
    expect(nextWorkstationName([])).toBe("ws-01");
    expect(nextWorkstationName(["ws-01", "ws-03"])).toBe("ws-02");
  });
});

/**
 * Freezes a value and everything it holds, so that a reducer which mutates its input fails the test.
 *
 * @param value - The value to freeze.
 * @returns The same value.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * A confirmed plan with a charger and one workstation at (4, 1), footprint 2 m by 2 m. The small drawing is 10 m by
 * 2 m, so the footprint spans the full height of the plan.
 */
function withWorkstation(): WizardState {
  return run(
    inEditor(),
    { type: "placeCharger", at: [1, 1] },
    { type: "addWorkstation", at: [4, 1] },
  );
}

describe("workstation footprint", () => {
  it("adds a workstation with the default footprint, centred on the click", () => {
    const state = withWorkstation();
    expect(state.editor.workstations[0]?.size).toEqual({
      width: DEFAULT_WORKSTATION_SIZE_M,
      height: DEFAULT_WORKSTATION_SIZE_M,
    });
    expect(state.editor.workstations[0]?.at).toEqual([4, 1]);
  });

  it("keeps the footprint when the workstation is moved", () => {
    const state = run(withWorkstation(), {
      type: "moveBy",
      target: { kind: "workstation", index: 0 },
      dx: 1,
      dy: 0,
    });
    expect(state.editor.workstations[0]?.size).toEqual({ width: 2, height: 2 });
  });

  it("stores a typed size as entered, and does nothing when the size is unchanged", () => {
    const state = run(withWorkstation(), {
      type: "setWorkstationSize",
      index: 0,
      size: { width: 0, height: 60 },
    });
    expect(state.editor.workstations[0]?.size).toEqual({ width: 0, height: 60 });

    const same = wizardReducer(state, {
      type: "setWorkstationSize",
      index: 0,
      size: { width: 0, height: 60 },
    });
    expect(same).toBe(state);
  });

  it("does nothing for a missing workstation", () => {
    const state = withWorkstation();
    expect(
      wizardReducer(state, { type: "setWorkstationSize", index: 4, size: { width: 3, height: 3 } }),
    ).toBe(state);
  });

  it("is reported by the draft when the typed size is out of range", () => {
    const state = run(withWorkstation(), {
      type: "setWorkstationSize",
      index: 0,
      size: { width: 0, height: 60 },
    });
    const issues = draftIssues(state.editor, state.imported?.extent ?? null);
    expect(issues).toContainEqual({ kind: "badSize", index: 0 });
  });
});

describe("resizing", () => {
  it("resizes a workstation from its east edge, keeping its name and its west edge", () => {
    const state = run(withWorkstation(), {
      type: "resizeTo",
      target: { kind: "workstation", index: 0 },
      handle: "e",
      to: [6, 4],
    });
    expect(state.editor.workstations[0]).toEqual({
      name: "ws-01",
      at: [4.5, 1],
      size: { width: 3, height: 2 },
    });
  });

  it("clamps a workstation to the plan extent", () => {
    const state = run(withWorkstation(), {
      type: "resizeTo",
      target: { kind: "workstation", index: 0 },
      handle: "e",
      to: [50, 1],
    });
    expect(state.imported?.extent).toEqual([10, 2]);
    expect(workstationRect(state.editor.workstations[0] ?? failMissing())).toEqual({
      x: 3,
      y: 0,
      w: 7,
      h: 2,
    });
  });

  it("does not clamp before the plan is imported", () => {
    const state = run(
      INITIAL_WIZARD_STATE,
      { type: "addWorkstation", at: [4, 1] },
      { type: "resizeTo", target: { kind: "workstation", index: 0 }, handle: "e", to: [50, 1] },
    );
    expect(state.editor.workstations[0]?.size.width).toBe(47);
  });

  it("resizes only the no-go zone it names, and keeps the others by reference", () => {
    const placed = run(
      inEditor(),
      { type: "addNogo", rect: { x: 1, y: 1, w: 1, h: 1 } },
      { type: "addNogo", rect: { x: 6, y: 1, w: 1, h: 1 } },
    );
    const state = run(placed, {
      type: "resizeTo",
      target: { kind: "nogo", index: 0 },
      handle: "e",
      to: [3, 1],
    });
    expect(state.editor.nogo[0]).toEqual({ x: 1, y: 1, w: 2, h: 1 });
    expect(state.editor.nogo[1]).toBe(placed.editor.nogo[1]);
  });

  it("grows by one step with resizeBy, and keeps the lower-left corner", () => {
    const state = run(withWorkstation(), {
      type: "resizeBy",
      target: { kind: "workstation", index: 0 },
      dw: 0.1,
      dh: 0,
    });
    expect(state.editor.workstations[0]?.size).toEqual({ width: 2.1, height: 2 });
    expect(workstationRect(state.editor.workstations[0] ?? failMissing()).x).toBe(3);
  });

  it("returns the same state when a resize changes nothing", () => {
    const state = withWorkstation();
    const next = wizardReducer(state, {
      type: "resizeBy",
      target: { kind: "workstation", index: 0 },
      dw: -0.1,
      dh: 0,
    });
    const shrunk = run(state, {
      type: "resizeBy",
      target: { kind: "workstation", index: 0 },
      dw: -10,
      dh: 0,
    });
    expect(next.editor.workstations[0]?.size).toEqual({ width: 1.9, height: 2 });
    expect(
      wizardReducer(shrunk, {
        type: "resizeBy",
        target: { kind: "workstation", index: 0 },
        dw: -10,
        dh: 0,
      }),
    ).toBe(shrunk);
  });

  it("returns the same state when a no-go zone is set to the rectangle it already has", () => {
    const placed = run(inEditor(), { type: "addNogo", rect: { x: 1, y: 1, w: 1, h: 1 } });
    const same = wizardReducer(placed, {
      type: "setShape",
      target: { kind: "nogo", index: 0 },
      rect: { x: 1, y: 1, w: 1, h: 1 },
    });
    expect(same).toBe(placed);
  });

  it("returns the same state for a missing shape", () => {
    const state = withWorkstation();
    expect(
      wizardReducer(state, {
        type: "resizeTo",
        target: { kind: "workstation", index: 3 },
        handle: "e",
        to: [6, 1],
      }),
    ).toBe(state);
    expect(
      wizardReducer(state, {
        type: "resizeBy",
        target: { kind: "nogo", index: 0 },
        dw: 0.1,
        dh: 0,
      }),
    ).toBe(state);
  });

  it("keeps the selection while a shape is resized", () => {
    const selected = run(withWorkstation(), {
      type: "select",
      target: { kind: "workstation", index: 0 },
    });
    const state = run(selected, {
      type: "resizeTo",
      target: { kind: "workstation", index: 0 },
      handle: "e",
      to: [6, 1],
    });
    expect(state.selection).toEqual({ kind: "workstation", index: 0 });
  });
});

describe("cancelling a drag", () => {
  it("restores a workstation to the shape it had before the drag", () => {
    const start = withWorkstation();
    const dragged = run(start, {
      type: "resizeTo",
      target: { kind: "workstation", index: 0 },
      handle: "nw",
      to: [1, 1.5],
    });
    const restored = wizardReducer(dragged, {
      type: "restoreShape",
      target: { kind: "workstation", index: 0 },
      rect: workstationRect(start.editor.workstations[0] ?? failMissing()),
    });
    expect(restored.editor.workstations[0]).toEqual(start.editor.workstations[0]);
  });

  it("restores a 0.2 m workstation verbatim, where setShape would fit it to the minimum size", () => {
    const start = withWorkstation();
    const small = { x: 3.9, y: 0.9, w: 0.2, h: 0.2 };

    const restored = wizardReducer(start, {
      type: "restoreShape",
      target: { kind: "workstation", index: 0 },
      rect: small,
    });
    expect(workstationRect(restored.editor.workstations[0] ?? failMissing())).toEqual(small);

    const fitted = wizardReducer(start, {
      type: "setShape",
      target: { kind: "workstation", index: 0 },
      rect: small,
    });
    expect(fitted.editor.workstations[0]?.size).toEqual({ width: 0.5, height: 0.5 });
  });

  it("restores a no-go zone that crosses the plan edge verbatim, where setShape keeps it inside", () => {
    const start = run(inEditor(), { type: "addNogo", rect: { x: 1, y: 1, w: 1, h: 1 } });
    const crossing = { x: -1, y: 1, w: 3, h: 1 };

    const restored = wizardReducer(start, {
      type: "restoreShape",
      target: { kind: "nogo", index: 0 },
      rect: crossing,
    });
    expect(restored.editor.nogo[0]).toEqual(crossing);

    const fitted = wizardReducer(start, {
      type: "setShape",
      target: { kind: "nogo", index: 0 },
      rect: crossing,
    });
    expect(fitted.editor.nogo[0]?.x).toBe(0);
  });

  it("applies the limits to a shape it sets, so a restore cannot break an invariant", () => {
    const state = run(
      inEditor(),
      { type: "addNogo", rect: { x: 1, y: 1, w: 1, h: 1 } },
      {
        type: "setShape",
        target: { kind: "nogo", index: 0 },
        rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      },
    );
    expect(state.editor.nogo[0]).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });
});

describe("state discipline", () => {
  it("never mutates the state it receives", () => {
    const frozen = deepFreeze(withWorkstation());
    const actions: WizardAction[] = [
      { type: "resizeTo", target: { kind: "workstation", index: 0 }, handle: "se", to: [7, 0.5] },
      { type: "resizeBy", target: { kind: "workstation", index: 0 }, dw: 0.1, dh: -0.1 },
      { type: "setWorkstationSize", index: 0, size: { width: 3, height: 3 } },
      { type: "moveBy", target: { kind: "workstation", index: 0 }, dx: 1, dy: 1 },
    ];
    for (const action of actions) {
      expect(() => wizardReducer(frozen, action)).not.toThrow();
    }
  });
});

/**
 * Stops a test that expects a feature to exist; the assertion fails before this is reached in a passing run.
 *
 * @returns Never returns.
 * @throws Always.
 */
function failMissing(): never {
  throw new Error("the feature must exist in this test");
}
