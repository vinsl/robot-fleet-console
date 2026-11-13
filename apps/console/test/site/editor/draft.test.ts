/**
 * Draft checks and the canvas layers: each issue the operator can fix, and the plain layer mapping.
 */
import { describe, expect, it } from "vitest";
import {
  importGeometry,
  type EditorFeatures,
  type Rect,
} from "../../../src/site/dxf/build-site-map";
import {
  buildDraftMap,
  draftIssues,
  draftLayers,
  EMPTY_FEATURES,
} from "../../../src/site/editor/draft";
import { INITIAL_WIZARD_STATE, wizardReducer } from "../../../src/site/editor/wizard-reducer";
import { SMALL_DOC } from "./support";

/** A complete draft of the small plan: one charger and two named workstations inside the 10 m by 5 m plan. */
const COMPLETE: EditorFeatures = {
  charger: [1, 4],
  workstations: [
    { name: "dock-a", at: [8, 4], size: { width: 2, height: 2 } },
    { name: "pack-b", at: [8, 1], size: { width: 2, height: 2 } },
  ],
  nogo: [{ x: 5, y: 2, w: 1, h: 1 }],
};

/** The plan extent of the small drawing, in metres. */
const EXTENT: [number, number] = [10, 5];

describe("draftIssues", () => {
  it("is empty for a complete draft inside the plan", () => {
    expect(draftIssues(COMPLETE, EXTENT)).toEqual([]);
  });

  it("asks for a charger and two workstations first", () => {
    expect(draftIssues(EMPTY_FEATURES, EXTENT)).toEqual([
      { kind: "noCharger" },
      { kind: "fewWorkstations" },
    ]);
  });

  it("flags a name the protocol refuses and a repeated name", () => {
    const issues = draftIssues(
      {
        ...COMPLETE,
        workstations: [
          { name: "Bad Name", at: [8, 4], size: { width: 2, height: 2 } },
          { name: "pack-b", at: [8, 1], size: { width: 2, height: 2 } },
          { name: "pack-b", at: [7, 1], size: { width: 2, height: 2 } },
        ],
      },
      EXTENT,
    );
    expect(issues).toEqual([
      { kind: "badName", index: 0 },
      { kind: "duplicateName", index: 2 },
    ]);
  });

  it("flags a no-go zone with no area, and a value that is not finite", () => {
    const bad: Rect[] = [
      { x: 1, y: 1, w: 0, h: 2 },
      { x: Number.NaN, y: 1, w: 1, h: 1 },
    ];
    expect(draftIssues({ ...COMPLETE, nogo: bad }, EXTENT)).toEqual([
      { kind: "badNogo", index: 0 },
      { kind: "badNogo", index: 1 },
    ]);
  });

  it("flags a feature outside the plan, and a no-go zone with one corner outside", () => {
    const issues = draftIssues(
      {
        ...COMPLETE,
        charger: [-1, 4],
        nogo: [{ x: 9.5, y: 1, w: 1, h: 1 }],
      },
      EXTENT,
    );
    expect(issues).toEqual([
      { kind: "outside", item: { kind: "charger" } },
      { kind: "outside", item: { kind: "nogo", index: 0 } },
    ]);
  });

  it("flags a workstation footprint with a size outside the protocol range, and a size that is not finite", () => {
    const issues = draftIssues(
      {
        ...COMPLETE,
        workstations: [
          { name: "dock-a", at: [8, 4], size: { width: 0, height: 2 } },
          { name: "pack-b", at: [8, 1], size: { width: 2, height: 60 } },
          { name: "dock-c", at: [6, 1], size: { width: Number.NaN, height: 2 } },
        ],
      },
      EXTENT,
    );
    expect(issues).toEqual([
      { kind: "badSize", index: 0 },
      { kind: "badSize", index: 1 },
      { kind: "badSize", index: 2 },
    ]);
  });

  it("flags a workstation whose footprint crosses the plan edge, though its centre is inside", () => {
    const issues = draftIssues(
      {
        ...COMPLETE,
        workstations: [
          { name: "dock-a", at: [9.5, 4], size: { width: 2, height: 2 } },
          { name: "pack-b", at: [8, 1], size: { width: 2, height: 2 } },
        ],
      },
      EXTENT,
    );
    expect(issues).toEqual([{ kind: "outside", item: { kind: "workstation", index: 0 } }]);
  });

  it("reports only the size of a workstation that has a bad size, and not its position", () => {
    const issues = draftIssues(
      {
        ...COMPLETE,
        workstations: [
          { name: "dock-a", at: [30, 4], size: { width: 0, height: 2 } },
          { name: "pack-b", at: [8, 1], size: { width: 2, height: 2 } },
        ],
      },
      EXTENT,
    );
    expect(issues).toEqual([{ kind: "badSize", index: 0 }]);
  });

  it("does not check the position before the plan is imported", () => {
    expect(draftIssues({ ...COMPLETE, charger: [-50, 4] }, null)).toEqual([]);
  });
});

describe("draftLayers", () => {
  it("draws the imported walls and obstacles with the placed features", () => {
    const imported = importGeometry({
      doc: SMALL_DOC,
      mapping: { WALLS: "wall", RACKS: "obstacle", TEXT: "ignore" },
      metresPerUnit: 0.001,
    });
    const layers = draftLayers(imported, COMPLETE);
    expect(layers.walls).toHaveLength(1);
    expect(layers.obstacles).toHaveLength(1);
    expect(layers.nogo).toHaveLength(1);
    expect(layers.charger).toEqual([1, 4]);
    expect(layers.workstations.map((station) => station.name)).toEqual(["dock-a", "pack-b"]);
    expect(layers.workstations[0]?.size).toEqual({ width: 2, height: 2 });
  });

  it("draws the features alone before the import", () => {
    const layers = draftLayers(null, COMPLETE);
    expect(layers.walls).toEqual([]);
    expect(layers.obstacles).toEqual([]);
    expect(layers.nogo).toHaveLength(1);
  });
});

describe("buildDraftMap", () => {
  it("returns the protocol map of a complete draft", () => {
    const imported = importGeometry({
      doc: SMALL_DOC,
      mapping: { WALLS: "wall", RACKS: "obstacle", TEXT: "ignore" },
      metresPerUnit: 0.001,
    });
    // One wall, one obstacle, the charger, two workstations and one no-go zone.
    expect(buildDraftMap(imported, COMPLETE)?.features).toHaveLength(6);
  });

  it("returns null while the draft is incomplete", () => {
    const imported = importGeometry({
      doc: SMALL_DOC,
      mapping: { WALLS: "wall", RACKS: "obstacle", TEXT: "ignore" },
      metresPerUnit: 0.001,
    });
    expect(buildDraftMap(imported, EMPTY_FEATURES)).toBeNull();
  });
});

describe("the wizard feeds the draft", () => {
  it("keeps the issues in step with the placed features", () => {
    const confirmed = wizardReducer(
      wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC }),
      { type: "confirmMapping" },
    );
    const state = wizardReducer(confirmed, { type: "placeCharger", at: [1, 4] });
    expect(draftIssues(state.editor, [10, 5])).toEqual([{ kind: "fewWorkstations" }]);
  });
});
