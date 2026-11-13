/**
 * Units of the header and the conversion of arcs and circles into points.
 */
import { describe, expect, it } from "vitest";
import {
  ARC_STEP_DEG,
  arcToPoints,
  circleToRing,
  toPolylines,
} from "../../../src/site/dxf/geometry";
import { metresPerUnit } from "../../../src/site/dxf/units";
import type { DxfEntity } from "../../../src/site/dxf/types";

describe("metresPerUnit", () => {
  it("converts the common insertion units", () => {
    expect(metresPerUnit(4)).toBe(0.001);
    expect(metresPerUnit(6)).toBe(1);
    expect(metresPerUnit(1)).toBeCloseTo(0.0254, 12);
  });

  it("returns null for no header value and for an unknown code", () => {
    expect(metresPerUnit(null)).toBeNull();
    expect(metresPerUnit(0)).toBeNull();
    expect(metresPerUnit(999)).toBeNull();
  });
});

describe("arcToPoints", () => {
  it("draws a counter-clockwise quarter from 0 to 90 degrees, with both ends exact", () => {
    const points = arcToPoints([0, 0], 10, 0, 90);

    expect(points[0]?.[0]).toBeCloseTo(10, 9);
    expect(points[0]?.[1]).toBeCloseTo(0, 9);
    const last = points[points.length - 1];
    expect(last?.[0]).toBeCloseTo(0, 9);
    expect(last?.[1]).toBeCloseTo(10, 9);
    // 90 degrees in 9 steps gives positions every 10 degrees, so 45 degrees is not a position; check that
    // each one lies on the circle at its own angle instead.
    points.forEach((point, index) => {
      const angle = (index * 10 * Math.PI) / 180;
      expect(point[0]).toBeCloseTo(10 * Math.cos(angle), 9);
      expect(point[1]).toBeCloseTo(10 * Math.sin(angle), 9);
    });
  });

  it("wraps an end angle that is before the start", () => {
    const points = arcToPoints([0, 0], 1, 350, 10);
    const last = points.at(-1);

    expect(last?.[0]).toBeCloseTo(Math.cos(Math.PI / 18), 9);
    expect(last?.[1]).toBeCloseTo(Math.sin(Math.PI / 18), 9);
    expect(points.length).toBeGreaterThan(2);
  });

  it("keeps every step at most ARC_STEP_DEG wide", () => {
    const points = arcToPoints([0, 0], 1000, 0, 360);

    expect(points.length - 1).toBeGreaterThanOrEqual(360 / ARC_STEP_DEG);
    const step = (2 * Math.PI * 1000 * ARC_STEP_DEG) / 360;
    let previous = points[0];
    for (const current of points.slice(1)) {
      if (previous === undefined) {
        throw new Error("expected a position");
      }
      const chord = Math.hypot(current[0] - previous[0], current[1] - previous[1]);
      expect(chord).toBeLessThanOrEqual(step * 1.0001);
      previous = current;
    }
  });
});

describe("circleToRing", () => {
  it("returns 24 positions and closes the ring on its first position", () => {
    const ring = circleToRing([100, 200], 50);

    expect(ring).toHaveLength(25);
    expect(ring[24]).toEqual(ring[0]);
    expect(ring[0]?.[0]).toBeCloseTo(150, 9);
    expect(ring[0]?.[1]).toBeCloseTo(200, 9);
  });
});

describe("toPolylines", () => {
  it("returns one polyline for each shape of an entity", () => {
    const line: DxfEntity = { kind: "line", layer: "A", a: [0, 0], b: [1, 0] };
    const polyline: DxfEntity = {
      kind: "polyline",
      layer: "A",
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      closed: true,
    };
    const circle: DxfEntity = { kind: "circle", layer: "A", center: [0, 0], radius: 1 };
    const arc: DxfEntity = {
      kind: "arc",
      layer: "A",
      center: [0, 0],
      radius: 1,
      startDeg: 0,
      endDeg: 90,
    };

    expect(toPolylines(line)).toEqual([
      {
        points: [
          [0, 0],
          [1, 0],
        ],
        closed: false,
      },
    ]);
    expect(toPolylines(polyline)[0]?.closed).toBe(true);
    expect(toPolylines(circle)[0]?.closed).toBe(true);
    expect(toPolylines(arc)[0]?.closed).toBe(false);
  });
});
