/**
 * Interaction geometry of the editor: the scale of the plan on the screen, the minimum pointer target, and the
 * inflation of a visible shape into its target.
 */
import { describe, expect, it } from "vitest";
import {
  FALLBACK_VIEW_PX,
  HIT_TARGET_PX,
  hitRect,
  hitSquareAt,
  minTargetM,
  pxPerMetre,
} from "../../../src/site/editor/hit-targets";

describe("pxPerMetre", () => {
  it("is the measured width of the plan divided by the width of its view box", () => {
    expect(pxPerMetre(800, 80)).toBe(10);
  });

  it("falls back to the fixed width when the plan has no measured width", () => {
    expect(pxPerMetre(0, 40)).toBe(FALLBACK_VIEW_PX / 40);
  });
});

describe("minTargetM", () => {
  it("is the side in metres that reaches the minimum target on the screen", () => {
    expect(HIT_TARGET_PX).toBe(44);
    expect(minTargetM(10)).toBeCloseTo(4.4);
  });
});

describe("hitRect", () => {
  it("grows a small rectangle about its centre until each side reaches the minimum", () => {
    const target = hitRect({ x: 0, y: 0, w: 1, h: 1 }, minTargetM(10));
    expect(target.w).toBeCloseTo(4.4);
    expect(target.h).toBeCloseTo(4.4);
    expect(target.x + target.w / 2).toBeCloseTo(0.5);
    expect(target.y + target.h / 2).toBeCloseTo(0.5);
  });

  it("never shrinks a rectangle already larger than the minimum", () => {
    const large = { x: 2, y: 3, w: 20, h: 20 };
    expect(hitRect(large, minTargetM(10))).toEqual(large);
  });

  it("grows each side on its own: a thin rectangle keeps its long side", () => {
    const target = hitRect({ x: 0, y: 0, w: 10, h: 0.5 }, 4.4);
    expect(target.w).toBe(10);
    expect(target.h).toBeCloseTo(4.4);
  });
});

describe("hitSquareAt", () => {
  it("is a square of the given side centred on the point", () => {
    expect(hitSquareAt([1, 2], 4)).toEqual({ x: -1, y: 0, w: 4, h: 4 });
  });
});
