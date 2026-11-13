/**
 * The committed sample warehouse drawing, read through the real DXF parser: layer roles, entity limits, the
 * conversion report and a site map that passes the protocol schema. The file is the one the generator writes, so
 * this test fails when the sample stops being importable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SiteMapSchema, type SiteMap } from "@mfc/protocol";
import { buildSiteMap, importGeometry } from "../../../src/site/dxf/build-site-map";
import { suggestMapping, type LayerMapping } from "../../../src/site/dxf/layer-mapping";
import { parseDxf } from "../../../src/site/dxf/parse-dxf";
import type { DxfDocument, Point } from "../../../src/site/dxf/types";
import { DXF_LIMITS } from "../../../src/site/dxf/types";
import { metresPerUnit } from "../../../src/site/dxf/units";

/**
 * Path of the sample, resolved from this file so the test does not depend on the working directory: from
 * `apps/console/test/site/dxf/` up to the repository root, then down to the generator's output.
 */
const SAMPLE_PATH = fileURLToPath(
  new URL("../../../../../agent/tools/sample/warehouse.dxf", import.meta.url),
);

/** Layers the generator writes, sorted. Block entities inherit the layer of their INSERT, so layer `0` is absent. */
const EXPECTED_LAYERS = ["DIMENSIONS", "MACHINES", "NOTES", "RACKS", "WALLS"];

/** Roles the mapping must suggest for the sample layers, by name. */
const EXPECTED_MAPPING: LayerMapping = {
  WALLS: "wall",
  RACKS: "obstacle",
  MACHINES: "obstacle",
  DIMENSIONS: "ignore",
  NOTES: "ignore",
};

/**
 * Walls and obstacles the importer produces from each layer, with the role the layer is mapped to. The counts come
 * from the elements the generator draws: WALLS holds the closed outer ring, two partitions and one door arc; RACKS
 * holds twelve INSERTs of block `RACK`; MACHINES holds two closed polylines and two pillars (circles); DIMENSIONS
 * and NOTES are ignored.
 */
const EXPECTED_GEOMETRY_PER_LAYER: Readonly<
  Record<
    string,
    {
      readonly role: "wall" | "obstacle" | "ignore";
      readonly walls: number;
      readonly obstacles: number;
    }
  >
> = {
  WALLS: { role: "wall", walls: 4, obstacles: 0 },
  RACKS: { role: "obstacle", walls: 0, obstacles: 12 },
  MACHINES: { role: "obstacle", walls: 0, obstacles: 4 },
  DIMENSIONS: { role: "ignore", walls: 0, obstacles: 0 },
  NOTES: { role: "ignore", walls: 0, obstacles: 0 },
};

/** Sample drawing read from disk, once for the whole file. */
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is a constant resolved from this module, not input
const sampleText = readFileSync(SAMPLE_PATH, "utf8");

/**
 * Returns the metres-per-unit scale the sample declares.
 *
 * @param doc - The parsed sample.
 * @returns The scale in metres per drawing unit.
 * @throws When the sample declares no supported unit.
 */
function sampleScale(doc: DxfDocument): number {
  const scale = metresPerUnit(doc.insUnits);
  if (scale === null) {
    // The sample declares millimetres, so a missing scale is a regression in the sample or the unit table.
    throw new Error("sample declares no supported unit");
  }
  return scale;
}

/**
 * Tells whether a polyline ends away from where it starts.
 *
 * @param points - The polyline in metres.
 * @returns `true` when the first and last positions differ.
 */
function isOpen(points: readonly Point[]): boolean {
  const first = points[0];
  const last = points.at(-1);
  return first === undefined || last === undefined || first[0] !== last[0] || first[1] !== last[1];
}

/**
 * Returns the features of a site map with a given geometry type and feature kind.
 *
 * @param map - The site map.
 * @param geometryType - The GeoJSON geometry type to keep.
 * @param kind - The feature kind to keep.
 * @returns The matching features.
 */
function featuresOf(map: SiteMap, geometryType: string, kind: string): SiteMap["features"] {
  return map.features.filter(
    (feature) => feature.geometry.type === geometryType && feature.properties.kind === kind,
  );
}

describe("committed sample warehouse.dxf", () => {
  it("parses into the expected layers", () => {
    const doc = parseDxf(sampleText);

    expect(doc.layers.map((layer) => layer.name).sort()).toEqual(EXPECTED_LAYERS);
  });

  it("is in millimetres, the unit the importer scales from", () => {
    expect(parseDxf(sampleText).insUnits).toBe(4);
  });

  it("stays within the import limits and has entities", () => {
    const doc = parseDxf(sampleText);

    expect(doc.entities.length).toBeGreaterThan(0);
    expect(doc.entities.length).toBeLessThanOrEqual(DXF_LIMITS.maxExpandedEntities);
    expect(doc.layers.length).toBeLessThanOrEqual(DXF_LIMITS.maxLayers);
  });

  it("reports the text entities as ignored and expands the arc and the rack block", () => {
    const doc = parseDxf(sampleText);

    expect(doc.ignored).toEqual({ TEXT: 1, MTEXT: 1 });
    // The door arc is read as an arc entity on WALLS, and the importer approximates it as an open polyline.
    const arcs = doc.entities.filter((entity) => entity.kind === "arc" && entity.layer === "WALLS");
    expect(arcs).toHaveLength(1);
    const walls = importGeometry({
      doc,
      mapping: EXPECTED_MAPPING,
      metresPerUnit: sampleScale(doc),
    }).walls;
    expect(walls.filter((wall) => wall.length > 2 && isOpen(wall))).toHaveLength(1);
    // Each of the twelve INSERTs of block RACK expands into one closed polyline on layer RACKS.
    const rackPolylines = doc.entities.filter(
      (entity) => entity.kind === "polyline" && entity.layer === "RACKS" && entity.closed,
    );
    expect(rackPolylines).toHaveLength(12);
  });

  it("suggests the expected role for every layer", () => {
    const doc = parseDxf(sampleText);

    expect(suggestMapping(doc.layers)).toEqual(EXPECTED_MAPPING);
  });

  it("produces the expected walls and obstacles for every layer", () => {
    const doc = parseDxf(sampleText);
    const scale = sampleScale(doc);

    for (const [layer, expected] of Object.entries(EXPECTED_GEOMETRY_PER_LAYER)) {
      const imported = importGeometry({
        doc,
        mapping: { [layer]: expected.role },
        metresPerUnit: scale,
      });
      expect({ layer, walls: imported.walls.length, obstacles: imported.obstacles.length }).toEqual(
        {
          layer,
          walls: expected.walls,
          obstacles: expected.obstacles,
        },
      );
    }
  });

  it("builds a site map that passes the protocol schema with the expected features", () => {
    const doc = parseDxf(sampleText);
    const imported = importGeometry({
      doc,
      mapping: EXPECTED_MAPPING,
      metresPerUnit: sampleScale(doc),
    });
    // The protocol needs one charger and at least two workstations, which the operator places in the wizard.
    const map = buildSiteMap(
      imported,
      {
        charger: [2, 2],
        workstations: [
          { name: "ws-1", at: [10, 30], size: { width: 2, height: 2 } },
          { name: "ws-2", at: [50, 30], size: { width: 2, height: 2 } },
        ],
        nogo: [],
      },
      1,
    );

    expect(SiteMapSchema.safeParse(map).success).toBe(true);
    expect(featuresOf(map, "LineString", "wall")).toHaveLength(4);
    expect(featuresOf(map, "Polygon", "obstacle")).toHaveLength(16);
    expect(featuresOf(map, "Point", "charger")).toHaveLength(1);
    expect(featuresOf(map, "Point", "workstation")).toHaveLength(2);
    expect(map.features).toHaveLength(23);
  });
});
