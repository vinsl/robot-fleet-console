/**
 * From drawing to site map: layer roles, geometry import, the editor features and the protocol check.
 */
import { describe, expect, it } from "vitest";
import { parseSiteMap } from "@mfc/protocol";
import {
  buildSiteMap,
  importGeometry,
  rectToRing,
  SiteMapBuildError,
  type EditorFeatures,
} from "../../../src/site/dxf/build-site-map";
import { suggestMapping, type LayerMapping } from "../../../src/site/dxf/layer-mapping";
import { parseDxf } from "../../../src/site/dxf/parse-dxf";
import { metresPerUnit } from "../../../src/site/dxf/units";
import type { DxfDocument } from "../../../src/site/dxf/types";
import { computeViewBox, lineToPath, ringToPath } from "../../../src/site/svg-paths";
import { dxf, header, line, section, type Pair } from "./support";

/** A warehouse of 60 m by 40 m in millimetres, with walls, a rack, a pillar and a text note. */
function warehouse(): DxfDocument {
  const walls: Pair[] = [
    [0, "LWPOLYLINE"],
    [8, "WALLS"],
    [70, "1"],
    [10, "10000"],
    [20, "10000"],
    [10, "70000"],
    [20, "10000"],
    [10, "70000"],
    [20, "50000"],
    [10, "10000"],
    [20, "50000"],
  ];
  const rack: Pair[] = [
    [0, "LWPOLYLINE"],
    [8, "RACKS"],
    [70, "1"],
    [10, "20000"],
    [20, "20000"],
    [10, "23000"],
    [20, "20000"],
    [10, "23000"],
    [20, "21000"],
    [10, "20000"],
    [20, "21000"],
  ];
  const pillar: Pair[] = [
    [0, "CIRCLE"],
    [8, "RACKS"],
    [10, "40000"],
    [20, "30000"],
    [40, "300"],
  ];
  const note: Pair[] = [
    [0, "TEXT"],
    [8, "NOTES"],
    [10, "0"],
    [20, "0"],
  ];
  return parseDxf(
    dxf(
      header(4),
      section("ENTITIES", walls, rack, pillar, note, line("DIMENSIONS", [0, 0], [1, 0])),
    ),
  );
}

const MAPPING: LayerMapping = {
  WALLS: "wall",
  RACKS: "obstacle",
  NOTES: "ignore",
  DIMENSIONS: "ignore",
  "0": "ignore",
};

/** Editor features with a charger and two named workstations, and no no-go zone. */
const EDITOR: EditorFeatures = {
  charger: [5, 5],
  workstations: [
    { name: "ws-1", at: [10, 10], size: { width: 2, height: 2 } },
    { name: "ws-2", at: [30, 10], size: { width: 2, height: 2 } },
  ],
  nogo: [],
};

describe("suggestMapping", () => {
  it("proposes walls and obstacles from English and French layer names, and ignores the rest", () => {
    const mapping = suggestMapping([
      { name: "Walls", label: "Walls", entityCount: 1 },
      { name: "MUR-EXT", label: "MUR-EXT", entityCount: 1 },
      { name: "Racks", label: "Racks", entityCount: 1 },
      { name: "machines", label: "machines", entityCount: 1 },
      { name: "DIMENSIONS", label: "DIMENSIONS", entityCount: 1 },
    ]);

    expect(mapping).toEqual({
      Walls: "wall",
      "MUR-EXT": "wall",
      Racks: "obstacle",
      machines: "obstacle",
      DIMENSIONS: "ignore",
    });
  });

  it("defines own properties, so a layer named like a prototype member cannot alter the mapping", () => {
    const mapping = suggestMapping([{ name: "__proto__", label: "__proto__", entityCount: 1 }]);

    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
    expect(Object.hasOwn(mapping, "__proto__")).toBe(true);
  });
});

describe("importGeometry", () => {
  it("scales to metres, moves the bottom-left corner to the origin and drops the ignored layers", () => {
    const imported = importGeometry({
      doc: warehouse(),
      mapping: MAPPING,
      metresPerUnit: metresPerUnit(4) ?? 1,
    });

    expect(imported.originShift).toEqual([10, 10]);
    expect(imported.extent).toEqual([60, 40]);
    expect(imported.walls).toHaveLength(1);
    expect(imported.obstacles).toHaveLength(2);
    expect(imported.skippedOpenObstacles).toBe(0);
    for (const point of imported.walls.flat()) {
      expect(point[0]).toBeGreaterThanOrEqual(0);
      expect(point[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it("counts an open polyline on an obstacle layer as skipped", () => {
    const doc = parseDxf(dxf(header(4), section("ENTITIES", line("RACKS", [0, 0], [1000, 0]))));

    const imported = importGeometry({ doc, mapping: { RACKS: "obstacle" }, metresPerUnit: 0.001 });

    expect(imported.skippedOpenObstacles).toBe(1);
    expect(imported.obstacles).toHaveLength(0);
  });

  it("rounds to three decimals and removes repeated positions", () => {
    const doc = parseDxf(
      dxf(
        header(6),
        section("ENTITIES", [
          [0, "LWPOLYLINE"],
          [8, "WALLS"],
          [70, "0"],
          [10, "0"],
          [20, "0"],
          [10, "0.0001"],
          [20, "0"],
          [10, "1.23456"],
          [20, "0"],
        ]),
      ),
    );

    const imported = importGeometry({ doc, mapping: { WALLS: "wall" }, metresPerUnit: 1 });

    expect(imported.walls).toEqual([
      [
        [0, 0],
        [1.235, 0],
      ],
    ]);
  });

  it("refuses a scale that is not a positive finite number", () => {
    expect(() => importGeometry({ doc: warehouse(), mapping: MAPPING, metresPerUnit: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      importGeometry({ doc: warehouse(), mapping: MAPPING, metresPerUnit: Number.NaN }),
    ).toThrow(RangeError);
  });
});

describe("buildSiteMap", () => {
  const imported = importGeometry({ doc: warehouse(), mapping: MAPPING, metresPerUnit: 0.001 });

  it("assembles a map that the protocol schema accepts, with the version given", () => {
    const map = buildSiteMap(imported, EDITOR, 3);

    expect(map.fleet).toEqual({ crs: "local-metric", version: 3 });
    expect(parseSiteMap(JSON.stringify(map))).toEqual(map);
  });

  it("keeps layer names out of the output", () => {
    const hostile = parseDxf(
      dxf(
        header(4),
        section("ENTITIES", [
          [0, "LWPOLYLINE"],
          [8, "<img src=x onerror=alert(1)>"],
          [70, "1"],
          [10, "0"],
          [20, "0"],
          [10, "5000"],
          [20, "0"],
          [10, "5000"],
          [20, "5000"],
        ]),
      ),
    );
    const map = buildSiteMap(
      importGeometry({
        doc: hostile,
        mapping: { "<img src=x onerror=alert(1)>": "wall" },
        metresPerUnit: 0.001,
      }),
      EDITOR,
      1,
    );

    expect(JSON.stringify(map)).not.toContain("onerror");
  });

  it("refuses a map without a charger", () => {
    const attempt = () => buildSiteMap(imported, { ...EDITOR, charger: null }, 1);

    expect(attempt).toThrow(SiteMapBuildError);
    // The message is fixed on purpose so it never echoes the file; the schema path lives in the issues.
    let caught: unknown = null;
    try {
      attempt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SiteMapBuildError);
    const issues = caught instanceof SiteMapBuildError ? caught.issues : [];
    expect(issues.some((issue) => issue.startsWith("features:"))).toBe(true);
  });

  it("writes the footprint of each workstation, and the saved map parses back with it", () => {
    const sized: EditorFeatures = {
      ...EDITOR,
      workstations: [
        { name: "ws-1", at: [10, 10], size: { width: 2.5, height: 1 } },
        { name: "ws-2", at: [30, 10], size: { width: 2, height: 2 } },
      ],
    };
    const map = buildSiteMap(imported, sized, 1);
    const reread = parseSiteMap(JSON.stringify(map));

    const stations = reread.features.filter((feature) => feature.properties.kind === "workstation");
    expect(stations.map((feature) => feature.properties)).toEqual([
      { kind: "workstation", name: "ws-1", size: { width: 2.5, height: 1 } },
      { kind: "workstation", name: "ws-2", size: { width: 2, height: 2 } },
    ]);
  });

  it("refuses a workstation footprint outside the protocol range", () => {
    const flat = {
      ...EDITOR,
      workstations: [
        { name: "ws-1", at: [10, 10] as const, size: { width: 0, height: 2 } },
        { name: "ws-2", at: [30, 10] as const, size: { width: 2, height: 2 } },
      ],
    };
    expect(() => buildSiteMap(imported, flat, 1)).toThrow(SiteMapBuildError);
  });

  it("refuses a map with fewer than two workstations", () => {
    const single = {
      ...EDITOR,
      workstations: [{ name: "ws-1", at: [10, 10] as const, size: { width: 2, height: 2 } }],
    };

    expect(() => buildSiteMap(imported, single, 1)).toThrow(SiteMapBuildError);
  });

  it("refuses a map whose extent is over 1 000 m", () => {
    const far = importGeometry({
      doc: parseDxf(dxf(header(4), section("ENTITIES", line("WALLS", [0, 0], [1_200_000, 0])))),
      mapping: { WALLS: "wall" },
      metresPerUnit: 0.001,
    });

    expect(() => buildSiteMap(far, EDITOR, 1)).toThrow(SiteMapBuildError);
  });

  it("refuses a duplicated workstation name, which the schema requires to be unique", () => {
    const duplicated = {
      ...EDITOR,
      workstations: [
        { name: "ws-1", at: [10, 10] as const, size: { width: 2, height: 2 } },
        { name: "ws-1", at: [30, 10] as const, size: { width: 2, height: 2 } },
      ],
    };

    expect(() => buildSiteMap(imported, duplicated, 1)).toThrow(SiteMapBuildError);
  });

  it("adds a no-go zone as a closed counter-clockwise ring", () => {
    expect(rectToRing({ x: 1, y: 2, w: 3, h: 4 })).toEqual([
      [1, 2],
      [4, 2],
      [4, 6],
      [1, 6],
      [1, 2],
    ]);
    const map = buildSiteMap(imported, { ...EDITOR, nogo: [{ x: 1, y: 2, w: 3, h: 4 }] }, 1);

    expect(map.features.some((feature) => feature.properties.kind === "nogo")).toBe(true);
  });
});

describe("svg paths", () => {
  it("builds open and closed path data", () => {
    expect(
      lineToPath([
        [0, 0],
        [1, 2],
      ]),
    ).toBe("M 0 0 L 1 2");
    expect(
      ringToPath([
        [0, 0],
        [1, 0],
        [0, 0],
      ]),
    ).toBe("M 0 0 L 1 0 L 0 0 Z");
    expect(lineToPath([])).toBe("");
    expect(ringToPath([])).toBe("");
  });

  it("computes the bounds of a set of points, and zeros for none", () => {
    expect(
      computeViewBox([
        [1, 2],
        [4, -1],
      ]),
    ).toEqual({ minX: 1, minY: -1, width: 3, height: 3 });
    expect(computeViewBox([])).toEqual({ minX: 0, minY: 0, width: 0, height: 0 });
  });
});
