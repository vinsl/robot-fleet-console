/**
 * Pointer to metres: the flip of the plan, the proportional fallback, and the grid snap.
 */
import { describe, expect, it } from "vitest";
import { clientToMetres, snap } from "../../../src/site/editor/coords";

/** A view of 200 m by 100 m, flipped: the SVG origin is at the top-left of the frame. */
const VIEW = { minX: -2, minY: -102, width: 204, height: 104 };

/**
 * An SVG element double with a box and no screen matrix, as jsdom has it.
 *
 * @returns The double.
 */
function svgDouble(): SVGSVGElement {
  const box = { left: 10, top: 20, width: 408, height: 208, right: 418, bottom: 228, x: 10, y: 20 };
  return { getBoundingClientRect: () => box as DOMRect } as unknown as SVGSVGElement;
}

describe("clientToMetres", () => {
  it("maps the centre of the element to the centre of the view, with the y axis up", () => {
    // Centre of the box: 50% across and down. The view centre is (100, 50) metres in the site frame.
    expect(clientToMetres(svgDouble(), 10 + 204, 20 + 104, VIEW)).toEqual([100, 50]);
  });

  it("maps the top-left corner of the element to the top-left of the plan", () => {
    const point = clientToMetres(svgDouble(), 10, 20, VIEW);
    expect(point?.[0]).toBeCloseTo(-2);
    expect(point?.[1]).toBeCloseTo(102);
  });

  it("returns null for an element with no size", () => {
    const flat = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    } as unknown as SVGSVGElement;
    expect(clientToMetres(flat, 5, 5, VIEW)).toBeNull();
  });

  it("uses the screen matrix when the element has one", () => {
    const matrix = {
      inverse: () => ({}) as DOMMatrix,
    };
    const element = {
      getScreenCTM: () => matrix as unknown as DOMMatrix,
      createSVGPoint: () => ({
        x: 0,
        y: 0,
        matrixTransform: () => ({ x: 30, y: -40 }) as DOMPoint,
      }),
    } as unknown as SVGSVGElement;
    expect(clientToMetres(element, 1, 1, VIEW)).toEqual([30, 40]);
  });
});

describe("snap", () => {
  it("rounds to the 0.1 m grid, without float noise", () => {
    expect(snap([0.34, -0.26])).toEqual([0.3, -0.3]);
    expect(snap([0.3 + 0.1 + 0.1, 0])).toEqual([0.5, 0]);
  });

  it("returns no negative zero", () => {
    expect(Object.is(snap([-0.01, 0])[0], -0)).toBe(false);
  });
});
