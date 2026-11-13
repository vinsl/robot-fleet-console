/**
 * Projection of the fleet map: the content fit, the zoom and pan, the tilt and the perspective, and their inverses.
 * Every case is pure geometry, so the tests run without a DOM.
 */
import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEW,
  applyView,
  centreOn,
  fitContent,
  interpolateView,
  panBy,
  projectPlanePoint,
  screenHeading,
  siteToContent,
  siteToScreen,
  unprojectToPlane,
  zoomAt,
  type ContentFrame,
  type PlaneGeometry,
} from "../../../src/fleet/map/projection";
import { map } from "../../../src/theme/tokens";

const DEG = Math.PI / 180;

/**
 * Builds a plane whose transform origin sits on the stage centre row, so that the origin row is easy to reason
 * about.
 *
 * @param tiltDeg - Tilt in degrees.
 * @returns The plane geometry.
 */
function planeAt(tiltDeg: number): PlaneGeometry {
  const planeWidth = 800;
  const planeHeight = 600;
  return {
    stageWidth: 1000,
    stageHeight: 800,
    planeLeft: 100,
    planeTop: 100,
    planeWidth,
    planeHeight,
    originX: planeWidth * 0.5,
    originY: planeHeight * 0.6,
    tiltRad: tiltDeg * DEG,
    perspectivePx: 1100,
  };
}

const VIEW_BOX = { minX: -2, minY: -12, width: 40, height: 20 };
const FRAME: ContentFrame = fitContent(VIEW_BOX, 800, 600);

/**
 * Asserts that two points are equal within a tolerance.
 *
 * @param actual - The point produced.
 * @param expected - The point expected.
 * @param digits - Decimal digits of the tolerance.
 */
function expectClose(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  digits = 6,
): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

describe("fitContent", () => {
  it("keeps the aspect ratio of the map and centres it in the plane", () => {
    const frame = fitContent({ minX: 0, minY: 0, width: 40, height: 20 }, 800, 600);
    expect(frame.width).toBe(800);
    expect(frame.height).toBe(400);
    expect(frame.left).toBe(0);
    expect(frame.top).toBe(100);
  });
});

describe("siteToContent", () => {
  it("flips y: a point further north is higher on the screen", () => {
    const north = siteToContent({ x: 0, y: 10 }, FRAME);
    const south = siteToContent({ x: 0, y: -10 }, FRAME);
    expect(north.y).toBeLessThan(south.y);
  });

  it("maps the corners of the view box to the corners of the frame", () => {
    const topLeft = siteToContent({ x: VIEW_BOX.minX, y: -VIEW_BOX.minY }, FRAME);
    expect(topLeft.x).toBeCloseTo(FRAME.left, 6);
    expect(topLeft.y).toBeCloseTo(FRAME.top, 6);
  });
});

describe("tilt and perspective", () => {
  it("is the identity (up to the plane offset) when the tilt is zero", () => {
    const plane = planeAt(0);
    expectClose(projectPlanePoint({ x: 123, y: 45 }, plane), { x: 100 + 123, y: 100 + 45 });
  });

  it("leaves the origin row unchanged at any tilt", () => {
    const origin = { x: 400, y: 360 };
    for (const tilt of [0, 30, 42]) {
      expectClose(projectPlanePoint(origin, planeAt(tilt)), projectPlanePoint(origin, planeAt(0)));
    }
  });

  it("moves a point above the origin towards the stage centre when tilted", () => {
    // The plane origin sits on the stage centre row, so the centre is where a tilted point converges.
    const plane = { ...planeAt(42), planeTop: 800 / 2 - 360 };
    const above = { x: 400, y: 360 - 100 };
    const flat = projectPlanePoint(above, { ...plane, tiltRad: 0 });
    const tilted = projectPlanePoint(above, plane);
    const centreY = 400;
    expect(Math.abs(tilted.y - centreY)).toBeLessThan(Math.abs(flat.y - centreY));
  });

  it.each([0, 30, 42])("unprojects what it projects at a %d degree tilt", (tilt) => {
    const plane = planeAt(tilt);
    for (let x = 0; x <= 800; x += 200) {
      for (let y = 0; y <= 600; y += 150) {
        const point = { x, y };
        expectClose(unprojectToPlane(projectPlanePoint(point, plane), plane), point, 6);
      }
    }
  });
});

describe("zoomAt", () => {
  it("keeps the anchor under the same screen position", () => {
    const view = { zoom: 1.5, panX: 30, panY: -20 };
    const anchor = { x: 250, y: 180 };
    const zoomed = zoomAt(view, 2, anchor, FRAME);
    const beforeUnder = unproject(anchor, view);
    expectClose(applyView(beforeUnder, FRAME, zoomed), anchor, 6);
  });

  it("clamps the zoom to the bounds of the map", () => {
    expect(zoomAt(IDENTITY_VIEW, 1000, { x: 0, y: 0 }, FRAME).zoom).toBe(map.zoomMax);
    expect(zoomAt(IDENTITY_VIEW, 0.001, { x: 0, y: 0 }, FRAME).zoom).toBe(map.zoomMin);
  });
});

describe("panBy", () => {
  it("divides the vertical move by the cosine of the tilt", () => {
    const view = panBy(IDENTITY_VIEW, 10, 10, planeAt(60));
    expect(view.panX).toBe(10);
    expect(view.panY).toBeCloseTo(10 / Math.cos(60 * DEG), 6);
  });

  it("does not change the zoom", () => {
    expect(panBy({ zoom: 2, panX: 0, panY: 0 }, 5, 5, planeAt(0)).zoom).toBe(2);
  });
});

describe("centreOn", () => {
  it("puts the site point at the content centre at the current zoom", () => {
    const point = { x: 5, y: 3 };
    const view = centreOn({ zoom: 2, panX: 0, panY: 0 }, point, FRAME);
    const centre = { x: FRAME.left + FRAME.width / 2, y: FRAME.top + FRAME.height / 2 };
    expectClose(applyView(siteToContent(point, FRAME), FRAME, view), centre, 6);
    expect(view.zoom).toBe(2);
  });
});

describe("screenHeading", () => {
  it("reads a heading of zero as pointing right at zero tilt", () => {
    const angle = screenHeading({ x: 10, y: 5 }, 0, FRAME, IDENTITY_VIEW, planeAt(0));
    expect(angle).toBeCloseTo(0, 6);
  });

  it("reads a heading of pi/2 as pointing up the screen", () => {
    const angle = screenHeading({ x: 10, y: 5 }, Math.PI / 2, FRAME, IDENTITY_VIEW, planeAt(0));
    expect(angle).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe("siteToScreen", () => {
  it("applies the content, the view and the projection in that order", () => {
    const plane = planeAt(0);
    const point = { x: 1, y: 2 };
    const expected = projectPlanePoint(
      applyView(siteToContent(point, FRAME), FRAME, IDENTITY_VIEW),
      plane,
    );
    expectClose(siteToScreen(point, FRAME, IDENTITY_VIEW, plane), expected);
  });
});

describe("interpolateView", () => {
  it("returns the start at zero and the end at one", () => {
    const from = { zoom: 1, panX: 0, panY: 0 };
    const to = { zoom: 2, panX: 10, panY: -10 };
    expect(interpolateView(from, to, 0)).toEqual(from);
    expect(interpolateView(from, to, 1)).toEqual(to);
    expect(interpolateView(from, to, 0.5)).toEqual({ zoom: 1.5, panX: 5, panY: -5 });
  });
});

/**
 * Inverse of the view alone: the content point under a view point.
 *
 * @param p - A point after the view.
 * @param view - The view.
 * @returns The point before the view.
 */
function unproject(
  p: { x: number; y: number },
  view: { zoom: number; panX: number; panY: number },
): { x: number; y: number } {
  const c = { x: FRAME.left + FRAME.width / 2, y: FRAME.top + FRAME.height / 2 };
  return {
    x: c.x + (p.x - c.x - view.panX) / view.zoom,
    y: c.y + (p.y - c.y - view.panY) / view.zoom,
  };
}
