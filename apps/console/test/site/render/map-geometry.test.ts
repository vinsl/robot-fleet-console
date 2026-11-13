/**
 * Grouping of the features and the view box that frames them. The sample map is the protocol fixture, so the
 * console and the planner read the same file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSiteMap, type SiteMap } from "@mfc/protocol";
import {
  CHARGER_LABEL_OFFSET_UNITS,
  featureLayers,
  LABEL_CLEARANCE_UNITS,
  LABEL_SIZE_UNITS,
  mapViewBox,
  markerUnit,
  PLAN_UNITS_ACROSS,
  stationLabelOffset,
  VIEW_PADDING_M,
  WORKSTATION_LABEL_OFFSET_UNITS,
  type FeatureLayers,
} from "../../../src/site/render/map-geometry";

const SAMPLE = parseSiteMap(
  readFileSync("../../packages/protocol/test/fixtures/site-map/sample-warehouse.geojson", "utf8"),
);

describe("featureLayers", () => {
  it("groups every kind of the sample map by how it is drawn", () => {
    const layers = featureLayers(SAMPLE);
    expect(layers.walls).toHaveLength(1);
    expect(layers.obstacles).toHaveLength(3);
    expect(layers.nogo).toHaveLength(1);
    expect(layers.charger).not.toBeNull();
    expect(layers.workstations.map((workstation) => workstation.name)).toEqual([
      "dock-a",
      "dock-b",
      "pack-c",
      "pack-d",
    ]);
  });

  it("keeps the positions of each feature in order and unchanged", () => {
    const layers = featureLayers(SAMPLE);
    const nogo = SAMPLE.features.find((feature) => feature.properties.kind === "nogo");
    expect(nogo?.geometry.type).toBe("Polygon");
    if (nogo?.geometry.type !== "Polygon") return;
    expect(layers.nogo[0]).toEqual(nogo.geometry.coordinates[0]);
  });

  it("returns empty layers and no charger for a map without features", () => {
    const empty: SiteMap = {
      type: "FeatureCollection",
      fleet: { crs: "local-metric", version: 1 },
      features: [],
    };
    expect(featureLayers(empty)).toEqual({
      walls: [],
      obstacles: [],
      nogo: [],
      charger: null,
      workstations: [],
    });
  });
});

describe("mapViewBox", () => {
  it("frames every position of the map, with the padding, in flipped SVG coordinates", () => {
    const layers = featureLayers(SAMPLE);
    const box = mapViewBox(layers);
    const points = [
      ...layers.walls.flat(),
      ...layers.obstacles.flat(),
      ...layers.nogo.flat(),
      ...(layers.charger === null ? [] : [layers.charger]),
      ...layers.workstations.map((workstation) => workstation.at),
    ];
    for (const [x, y] of points) {
      // The plan is drawn with `y` negated, so the SVG point of a site position is (x, -y).
      expect(x).toBeGreaterThanOrEqual(box.minX + VIEW_PADDING_M);
      expect(x).toBeLessThanOrEqual(box.minX + box.width - VIEW_PADDING_M);
      expect(-y).toBeGreaterThanOrEqual(box.minY + VIEW_PADDING_M);
      expect(-y).toBeLessThanOrEqual(box.minY + box.height - VIEW_PADDING_M);
    }
  });

  it("keeps the labels of a 200 m plan inside the frame", () => {
    // Charger at one corner, a workstation at each of two more corners: labels hang below the lowest anchor.
    const plan: FeatureLayers = {
      walls: [
        [
          [0, 0],
          [200, 0],
          [200, 120],
        ],
      ],
      obstacles: [],
      nogo: [],
      charger: [0, 0],
      workstations: [
        { name: "dock-a", at: [200, 0], size: null },
        { name: "pack-long-name", at: [200, 120], size: null },
      ],
    };
    const unit = markerUnit(plan);
    expect(unit).toBeCloseTo(200 / PLAN_UNITS_ACROSS);
    const box = mapViewBox(plan);
    // The plan is 200 m wide, so the padding is three marker units, not the 2 m floor.
    const pad = LABEL_CLEARANCE_UNITS * unit;
    expect(box.minX).toBeCloseTo(-pad);
    expect(box.minX + box.width).toBeCloseTo(200 + pad);
    // SVG y is the negated site y: the lowest anchor is at SVG y 0, and the charger label hangs below it.
    const chargerLabelBottom = (CHARGER_LABEL_OFFSET_UNITS + LABEL_SIZE_UNITS) * unit;
    expect(box.minY + box.height).toBeGreaterThanOrEqual(chargerLabelBottom);
    expect(box.minY + box.height).toBeCloseTo(pad);
    // The highest anchor (SVG y -120) keeps its own clearance on top, the same as the bottom.
    expect(box.minY).toBeCloseTo(-120 - pad);
  });

  it("gives a clearance that holds every label offset and size", () => {
    const widest =
      Math.max(CHARGER_LABEL_OFFSET_UNITS, WORKSTATION_LABEL_OFFSET_UNITS) + LABEL_SIZE_UNITS;
    expect(LABEL_CLEARANCE_UNITS).toBeGreaterThanOrEqual(widest);
  });

  it("uses a fixed frame for an empty map instead of a zero-sized one", () => {
    const layers = featureLayers({
      type: "FeatureCollection",
      fleet: { crs: "local-metric", version: 1 },
      features: [],
    });
    expect(mapViewBox(layers)).toEqual({ minX: 0, minY: 0, width: 10, height: 10 });
  });
});

describe("sized workstations", () => {
  it("frames the footprint of a sized workstation, not only its centre", () => {
    const plan = (size: FeatureLayers["workstations"][number]["size"]): FeatureLayers => ({
      walls: [],
      obstacles: [],
      nogo: [],
      charger: [0, 0],
      workstations: [{ name: "dock-a", at: [10, 0], size }],
    });
    // The footprint of 4 m reaches x = 12, so the frame is wider than the 10 m of the centre alone.
    const sized = mapViewBox(plan({ width: 4, height: 2 }));
    const point = mapViewBox(plan(null));
    expect(sized.width - point.width).toBeCloseTo(2);
    expect(sized.minX + sized.width).toBeCloseTo(12 + VIEW_PADDING_M);
  });

  it("keeps a point marker at the fixed label offset", () => {
    expect(stationLabelOffset(1, null)).toBe(WORKSTATION_LABEL_OFFSET_UNITS);
  });

  it("places the label under the footprint, and never closer than the fixed offset", () => {
    // A 3 m footprint: its lower edge is 1.5 m below the centre, and the label is one line below that edge.
    expect(stationLabelOffset(1, { width: 2, height: 3 })).toBeCloseTo(
      1.5 + LABEL_SIZE_UNITS - 0.2,
    );
    // A footprint smaller than the fixed offset keeps the fixed offset.
    expect(stationLabelOffset(1, { width: 0.2, height: 0.2 })).toBe(WORKSTATION_LABEL_OFFSET_UNITS);
  });
});
