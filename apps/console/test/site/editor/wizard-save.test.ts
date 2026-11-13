/**
 * Reducer transitions of the save and of the extent refusal: a plan beyond the protocol limit is refused at the
 * confirmation, and a save runs once at a time.
 */
import { describe, expect, it } from "vitest";
import { MAX_EXTENT_M } from "@mfc/protocol";
import {
  hasUnsavedDraft,
  INITIAL_WIZARD_STATE,
  wizardReducer,
  type WizardState,
} from "../../../src/site/editor/wizard-reducer";
import { completeDraftState } from "./draft-fixture";
import { SMALL_DOC } from "./support";

describe("confirmMapping extent refusal", () => {
  it("refuses a plan larger than the protocol limit before the editor", () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC });
    // One drawing unit is one metre: the 10 000 units of the fixture are 10 km across.
    state = wizardReducer(state, { type: "setScale", scale: 1 });
    state = wizardReducer(state, { type: "confirmMapping" });

    expect(state.error).toBe("extent");
    expect(state.step).toBe("mapping");
    expect(state.imported).toBeNull();
  });

  it("accepts a plan inside the limit and clears the refusal once the scale is fixed", () => {
    let state = wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC });
    state = wizardReducer(state, { type: "setScale", scale: 1 });
    state = wizardReducer(state, { type: "confirmMapping" });
    state = wizardReducer(state, { type: "setScale", scale: 0.001 });
    state = wizardReducer(state, { type: "confirmMapping" });

    expect(MAX_EXTENT_M).toBe(1000);
    expect(state.error).toBeNull();
    expect(state.step).toBe("edit");
  });
});

describe("save status", () => {
  const draft: WizardState = completeDraftState();

  it("marks a save as running and refuses a second start while it runs", () => {
    const running = wizardReducer(draft, { type: "saveStarted" });
    expect(running.save).toEqual({ kind: "saving" });
    expect(wizardReducer(running, { type: "saveStarted" })).toBe(running);
  });

  it("keeps the failure, so a reserved version can be validated again", () => {
    const failure = { stage: "validate" as const, reason: "api" as const, version: 2 };
    const failed = wizardReducer(wizardReducer(draft, { type: "saveStarted" }), {
      type: "saveFailed",
      failure,
    });
    expect(failed.save).toEqual({ kind: "failed", failure });
  });

  it("ends in done with the version, and clears the selection", () => {
    const version = {
      version: 2,
      status: "VALID" as const,
      createdAt: "2026-11-03T10:00:00.000Z",
      createdBy: "admin-1",
      sizeBytes: 10,
      summary: null,
      active: false,
    };
    const done = wizardReducer(draft, { type: "saved", version });
    expect(done.save).toEqual({ kind: "done", version });
    expect(done.selection).toBeNull();
  });

  it("returns to an empty wizard on reset", () => {
    const done = wizardReducer(draft, { type: "reset" });
    expect(done).toEqual(INITIAL_WIZARD_STATE);
  });
});

describe("hasUnsavedDraft", () => {
  it("is false before a drawing is picked, true for a draft, and false once saved", () => {
    expect(hasUnsavedDraft(INITIAL_WIZARD_STATE)).toBe(false);
    const draft = completeDraftState();
    expect(hasUnsavedDraft(draft)).toBe(true);
    const done = wizardReducer(draft, {
      type: "saved",
      version: {
        version: 2,
        status: "VALID",
        createdAt: "2026-11-03T10:00:00.000Z",
        createdBy: "admin-1",
        sizeBytes: 10,
        summary: null,
        active: false,
      },
    });
    expect(hasUnsavedDraft(done)).toBe(false);
  });
});
