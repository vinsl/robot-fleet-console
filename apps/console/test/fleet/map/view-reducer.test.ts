/**
 * The map viewport reducer: every gesture is an action, the state object is kept when nothing changes, and the
 * flat view is a separate flag.
 */
import { describe, expect, it } from "vitest";
import { IDENTITY_VIEW, fitContent, type PlaneGeometry } from "../../../src/fleet/map/projection";
import { INITIAL_MAP_VIEW, mapViewReducer } from "../../../src/fleet/map/view-reducer";
import { map } from "../../../src/theme/tokens";

const FRAME = fitContent({ minX: 0, minY: 0, width: 40, height: 20 }, 800, 600);
const PLANE: PlaneGeometry = {
  stageWidth: 1000,
  stageHeight: 800,
  planeLeft: 100,
  planeTop: 100,
  planeWidth: 800,
  planeHeight: 600,
  originX: 400,
  originY: 360,
  tiltRad: 0,
  perspectivePx: 1100,
};

describe("mapViewReducer", () => {
  it("zooms in and out by the zoom step, about the content centre", () => {
    const zoomed = mapViewReducer(INITIAL_MAP_VIEW, { type: "zoomIn", frame: FRAME });
    expect(zoomed.view.zoom).toBeCloseTo(map.zoomStep, 6);
    const back = mapViewReducer(zoomed, { type: "zoomOut", frame: FRAME });
    expect(back.view.zoom).toBeCloseTo(1, 6);
  });

  it("resets the view but keeps the flat flag", () => {
    const state = { view: { zoom: 3, panX: 10, panY: 4 }, flat: true };
    expect(mapViewReducer(state, { type: "reset" })).toEqual({ view: IDENTITY_VIEW, flat: true });
  });

  it("toggles the flat view", () => {
    const flat = mapViewReducer(INITIAL_MAP_VIEW, { type: "toggleFlat" });
    expect(flat.flat).toBe(true);
    expect(mapViewReducer(flat, { type: "toggleFlat" }).flat).toBe(false);
  });

  it("pans by a screen delta corrected for the tilt", () => {
    const state = mapViewReducer(INITIAL_MAP_VIEW, { type: "panBy", dx: 5, dy: 0, plane: PLANE });
    expect(state.view.panX).toBe(5);
    expect(state.view.panY).toBe(0);
  });

  it("returns the same state object when a gesture changes nothing", () => {
    const state = mapViewReducer(INITIAL_MAP_VIEW, { type: "panBy", dx: 0, dy: 0, plane: PLANE });
    expect(state).toBe(INITIAL_MAP_VIEW);
  });

  it("centres a site point with the focus action", () => {
    const state = mapViewReducer(INITIAL_MAP_VIEW, {
      type: "centreOn",
      p: { x: 20, y: 10 },
      frame: FRAME,
    });
    expect(state.view.zoom).toBe(1);
    expect(state.view.panX).not.toBe(0);
  });

  it("replaces the view with setView, used by the focus animation", () => {
    const view = { zoom: 2, panX: 1, panY: 2 };
    expect(mapViewReducer(INITIAL_MAP_VIEW, { type: "setView", view }).view).toEqual(view);
  });
});
