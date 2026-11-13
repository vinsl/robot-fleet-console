/**
 * Shape geometry of the editor: the rectangle of a workstation, the resize rules and the handle layout.
 */
import { describe, expect, it } from "vitest";
import type { Rect, Workstation } from "../../../src/site/dxf/build-site-map";
import {
  HANDLE_HIT_PX,
  HANDLES,
  MIN_SHAPE_SIZE_M,
  fitRect,
  growRect,
  handleHitPx,
  handlePoint,
  limitsFor,
  resizeRect,
  sameRect,
  visibleHandles,
  withWorkstationRect,
  workstationRect,
} from "../../../src/site/editor/shapes";

/** A plan of 20 m by 10 m, for the bounded cases. */
const PLAN = limitsFor("workstation", [20, 10]);

/** No plan known and no size cap: only the minimum applies. */
const FREE = limitsFor("nogo", null);

/** A workstation with a 4 m by 2 m footprint centred on (10, 5). */
const DOCK: Workstation = { name: "dock-a", at: [10, 5], size: { width: 4, height: 2 } };

describe("workstationRect and withWorkstationRect", () => {
  it("places the footprint around the workstation point", () => {
    expect(workstationRect(DOCK)).toEqual({ x: 8, y: 4, w: 4, h: 2 });
  });

  it("round-trips a footprint with fractional offsets, and keeps the name", () => {
    const station: Workstation = { name: "ws-01", at: [1.05, 2.05], size: { width: 2, height: 2 } };
    expect(withWorkstationRect(station, workstationRect(station))).toEqual(station);
  });

  it("puts the centre and the size back, rounded to the micrometre", () => {
    const rect: Rect = { x: 0, y: 0, w: 2.0000004, h: 3 };
    expect(withWorkstationRect(DOCK, rect)).toEqual({
      name: "dock-a",
      at: [1, 1.5],
      size: { width: 2, height: 3 },
    });
  });
});

describe("handlePoint", () => {
  it("gives the corners, the edge midpoints and the matching coordinates", () => {
    const rect: Rect = { x: 1, y: 2, w: 4, h: 6 };
    expect(handlePoint(rect, "n")).toEqual([3, 8]);
    expect(handlePoint(rect, "ne")).toEqual([5, 8]);
    expect(handlePoint(rect, "e")).toEqual([5, 5]);
    expect(handlePoint(rect, "se")).toEqual([5, 2]);
    expect(handlePoint(rect, "s")).toEqual([3, 2]);
    expect(handlePoint(rect, "sw")).toEqual([1, 2]);
    expect(handlePoint(rect, "w")).toEqual([1, 5]);
    expect(handlePoint(rect, "nw")).toEqual([1, 8]);
  });
});

describe("resizeRect", () => {
  const rect: Rect = { x: 1, y: 1, w: 2, h: 2 };

  it("grows the width when the east edge is dragged right, and leaves the other edges", () => {
    expect(resizeRect(rect, "e", [5, 99], FREE)).toEqual({ x: 1, y: 1, w: 4, h: 2 });
  });

  it("moves the west edge and shrinks the width, with the east edge fixed", () => {
    expect(resizeRect(rect, "w", [2, 0], FREE)).toEqual({ x: 2, y: 1, w: 1, h: 2 });
  });

  it("moves the north and west edges for a north-west corner, and keeps the south-east corner", () => {
    const tall: Rect = { x: 1, y: 1, w: 4, h: 4 };
    expect(resizeRect(tall, "nw", [0.5, 7], FREE)).toEqual({ x: 0.5, y: 1, w: 4.5, h: 6 });
  });

  it("stops the moving edge at the minimum size instead of flipping the shape", () => {
    expect(resizeRect({ x: 2, y: 1, w: 3, h: 2 }, "e", [0, 1], FREE)).toEqual({
      x: 2,
      y: 1,
      w: MIN_SHAPE_SIZE_M,
      h: 2,
    });
    expect(resizeRect({ x: 2, y: 1, w: 3, h: 2 }, "w", [10, 1], FREE)).toEqual({
      x: 5 - MIN_SHAPE_SIZE_M,
      y: 1,
      w: MIN_SHAPE_SIZE_M,
      h: 2,
    });
    expect(resizeRect({ x: 0, y: 0, w: 2, h: 4 }, "s", [0, 9], FREE)).toEqual({
      x: 0,
      y: 4 - MIN_SHAPE_SIZE_M,
      w: 2,
      h: MIN_SHAPE_SIZE_M,
    });
  });

  it("clamps the moving edge to the far side of the plan", () => {
    expect(resizeRect(rect, "e", [50, 1], PLAN)).toEqual({ x: 1, y: 1, w: 19, h: 2 });
    expect(resizeRect(rect, "n", [1, 50], PLAN)).toEqual({ x: 1, y: 1, w: 2, h: 9 });
  });

  it("clamps the moving edge to the origin of the plan", () => {
    expect(resizeRect(rect, "w", [-5, 0], PLAN)).toEqual({ x: 0, y: 1, w: 3, h: 2 });
    expect(resizeRect(rect, "s", [0, -5], PLAN)).toEqual({ x: 1, y: 0, w: 2, h: 3 });
  });

  it("caps a workstation footprint at the protocol maximum of 50 m", () => {
    const wide = resizeRect(
      { x: 0, y: 0, w: 2, h: 2 },
      "e",
      [80, 0],
      limitsFor("workstation", null),
    );
    expect(wide.w).toBe(50);
  });

  it("has no cap on a no-go zone", () => {
    expect(resizeRect({ x: 0, y: 0, w: 2, h: 2 }, "e", [80, 0], FREE).w).toBe(80);
  });

  it("does not clamp when the plan is not known yet, so negative coordinates are allowed", () => {
    expect(resizeRect({ x: 0, y: 0, w: 2, h: 2 }, "w", [-3, 0], FREE)).toEqual({
      x: -3,
      y: 0,
      w: 5,
      h: 2,
    });
  });

  it("is idempotent: applying the same handle and target twice equals applying it once", () => {
    const targets: [Rect, "se" | "e" | "nw", [number, number]][] = [
      [rect, "se", [7.3, -0.2]],
      [rect, "e", [0.4, 1]],
      [{ x: 3.05, y: 0.7, w: 4.1, h: 3.3 }, "nw", [1.25, 9.9]],
    ];
    for (const [start, handle, to] of targets) {
      const once = resizeRect(start, handle, to, PLAN);
      expect(resizeRect(once, handle, to, PLAN)).toEqual(once);
    }
  });

  it("leaves the shape unchanged for a target that is not finite", () => {
    expect(resizeRect(rect, "e", [Number.NaN, 0], PLAN)).toBe(rect);
  });

  it("keeps the shape inside the plan when it cannot also keep the minimum size", () => {
    // A plan narrower than the minimum: the plan bound wins, and no value becomes NaN.
    const narrow = limitsFor("nogo", [0.3, 10]);
    const result = resizeRect({ x: 0, y: 0, w: 0.2, h: 1 }, "e", [5, 0], narrow);
    expect(result).toEqual({ x: 0, y: 0, w: 0.3, h: 1 });
    expect(Number.isFinite(result.w)).toBe(true);
  });

  it("gives the plan priority over the minimum for an edge that already sits at the plan edge", () => {
    const result = resizeRect({ x: 19.8, y: 1, w: 0.2, h: 1 }, "e", [30, 1], PLAN);
    expect(result).toEqual({ x: 19.8, y: 1, w: 0.2, h: 1 });
  });
});

describe("growRect", () => {
  const rect: Rect = { x: 1, y: 1, w: 2, h: 2 };

  it("grows the width by one step from the east edge, with the corner fixed", () => {
    expect(growRect(rect, 0.1, 0, FREE)).toEqual({ x: 1, y: 1, w: 2.1, h: 2 });
  });

  it("shrinks the width and the height from the east and north edges", () => {
    expect(growRect(rect, -0.1, -0.1, FREE)).toEqual({ x: 1, y: 1, w: 1.9, h: 1.9 });
  });

  it("grows the height from the north edge", () => {
    expect(growRect(rect, 0, 0.1, FREE)).toEqual({ x: 1, y: 1, w: 2, h: 2.1 });
  });

  it("stops at the minimum size", () => {
    expect(growRect({ x: 1, y: 1, w: 0.5, h: 2 }, -0.1, 0, FREE).w).toBe(MIN_SHAPE_SIZE_M);
  });

  it("stops at the far side of the plan", () => {
    expect(growRect({ x: 18, y: 1, w: 2, h: 2 }, 0.1, 0, PLAN).w).toBe(2);
  });

  it("does not drift: ten steps of a tenth of a metre give exactly three metres", () => {
    let current = rect;
    for (let step = 0; step < 10; step += 1) {
      current = growRect(current, 0.1, 0, FREE);
    }
    expect(current.w).toBe(3);
  });
});

describe("fitRect", () => {
  it("leaves a shape that already fits unchanged", () => {
    const rect: Rect = { x: 1, y: 1, w: 2, h: 2 };
    expect(fitRect(rect, PLAN)).toEqual(rect);
  });

  it("raises a size below the minimum", () => {
    expect(fitRect({ x: 1, y: 1, w: 0.1, h: 0.1 }, FREE)).toEqual({
      x: 1,
      y: 1,
      w: MIN_SHAPE_SIZE_M,
      h: MIN_SHAPE_SIZE_M,
    });
  });

  it("caps a workstation footprint at 50 m", () => {
    expect(fitRect({ x: 0, y: 0, w: 60, h: 2 }, limitsFor("workstation", null)).w).toBe(50);
  });

  it("moves a shape back inside the plan", () => {
    expect(fitRect({ x: 19, y: 9, w: 2, h: 2 }, PLAN)).toEqual({ x: 18, y: 8, w: 2, h: 2 });
  });

  it("pins a shape longer than the plan to the origin of the plan", () => {
    expect(fitRect({ x: 5, y: 0, w: 30, h: 2 }, PLAN)).toEqual({ x: 0, y: 0, w: 30, h: 2 });
  });
});

describe("limitsFor", () => {
  it("caps a workstation at 50 m and a no-go zone at nothing", () => {
    expect(limitsFor("workstation", null)).toEqual({
      bounds: null,
      min: MIN_SHAPE_SIZE_M,
      max: 50,
    });
    expect(limitsFor("nogo", [5, 5]).max).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("visibleHandles", () => {
  // A scale of 10 px per metre: a side of 7.2 m is exactly the 72 px threshold.
  const SCALE = 10;

  it("draws all eight handles when both sides are long enough", () => {
    expect(visibleHandles({ x: 0, y: 0, w: 10, h: 10 }, SCALE)).toEqual(HANDLES);
  });

  it("hides the east and west handles when the width is short, and keeps the rest", () => {
    expect(visibleHandles({ x: 0, y: 0, w: 6, h: 10 }, SCALE)).toEqual([
      "n",
      "ne",
      "se",
      "s",
      "sw",
      "nw",
    ]);
  });

  it("hides the north and south handles when the height is short, and keeps the rest", () => {
    expect(visibleHandles({ x: 0, y: 0, w: 10, h: 6 }, SCALE)).toEqual([
      "ne",
      "e",
      "se",
      "sw",
      "w",
      "nw",
    ]);
  });

  it("leaves the four corners when both sides are short", () => {
    expect(visibleHandles({ x: 0, y: 0, w: 6, h: 6 }, SCALE)).toEqual(["ne", "se", "sw", "nw"]);
  });

  it("switches at exactly the threshold: 72 px is still long enough", () => {
    expect(visibleHandles({ x: 0, y: 0, w: 7.2, h: 7.2 }, SCALE)).toEqual(HANDLES);
    expect(visibleHandles({ x: 0, y: 0, w: 7.1, h: 7.1 }, SCALE)).toHaveLength(4);
  });
});

describe("handleHitPx", () => {
  it("is a third of the longest side, between 12 and 24 px", () => {
    expect(handleHitPx({ x: 0, y: 0, w: 6, h: 1 }, 10)).toBe(20);
    expect(handleHitPx({ x: 0, y: 0, w: 3, h: 1 }, 10)).toBe(12);
    expect(handleHitPx({ x: 0, y: 0, w: 20, h: 1 }, 10)).toBe(HANDLE_HIT_PX);
  });
});

describe("sameRect", () => {
  it("compares the four fields", () => {
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
  });
});
