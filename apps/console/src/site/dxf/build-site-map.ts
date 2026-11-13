/**
 * Turns a parsed drawing and the operator's choices into a site map that the protocol schema accepts.
 *
 * Two steps: {@link importGeometry} scales the drawing to metres and moves its corner to the origin, then
 * {@link buildSiteMap} adds the features the operator placed (charger, workstations, no-go zones) and checks
 * the result against `SiteMapSchema`. The schema is the single rule set; nothing here re-states it.
 *
 * Layer names never reach the output. Walls and obstacles carry geometry only, and every name in the map
 * comes from the operator, who types it in the editor and is bound by the protocol name grammar.
 */
import { SiteMapSchema, type SiteMap } from "@mfc/protocol";
import { layerRoles, type LayerMapping } from "./layer-mapping";
import { toPolylines, type Polyline } from "./geometry";
import type { DxfDocument, Point } from "./types";

/** Decimal places kept in the map. A millimetre in a metre frame; more precision is noise on a floor plan. */
const DECIMALS = 1000;

/** Input of the import: the parsed drawing, the layer roles, the scale and the version to write. */
export interface BuildInput {
  /** The parsed drawing. */
  readonly doc: DxfDocument;
  /** The role of each layer. A layer missing from it is ignored. */
  readonly mapping: LayerMapping;
  /** Metres per drawing unit. The caller applies the header unit or the operator's scale. */
  readonly metresPerUnit: number;
  /** Version number written into the map. */
  readonly version: number;
}

/**
 * Geometry of the drawing in metres, with its corner moved to the origin.
 */
export interface Imported {
  /** Wall polylines (LineStrings), in metres. */
  readonly walls: Point[][];
  /** Obstacle rings (closed polygons), in metres. */
  readonly obstacles: Point[][];
  /** Position of the drawing's bottom-left corner in the metric frame before the move, in metres. */
  readonly originShift: Point;
  /** Largest x and y of the moved geometry, in metres. */
  readonly extent: Point;
  /** Open polylines on obstacle layers, which cannot be a closed obstacle. They are skipped and counted. */
  readonly skippedOpenObstacles: number;
}

/** A rectangle of the editor, in metres: lower-left corner, width and height. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Width and height of a workstation footprint, in metres. */
export interface Size {
  /** Extent along x, in metres. */
  readonly width: number;
  /** Extent along y, in metres. */
  readonly height: number;
}

/** Side of the square footprint of a workstation the editor adds, in metres. */
export const DEFAULT_WORKSTATION_SIZE_M = 2;

/**
 * A workstation placed by the operator: a name matching the protocol grammar, the centre of its footprint and the
 * footprint size, in metres.
 */
export interface Workstation {
  readonly name: string;
  readonly at: Point;
  readonly size: Size;
}

/** Features the operator adds in the editor, in metres. */
export interface EditorFeatures {
  /** Charger position, or `null` when not placed yet. */
  readonly charger: Point | null;
  /** Workstations. */
  readonly workstations: readonly Workstation[];
  /** No-go rectangles. */
  readonly nogo: readonly Rect[];
}

/** A map that did not pass the protocol schema, with the schema's issues as fixed text. */
export class SiteMapBuildError extends Error {
  /** One line per issue: its path and the schema message. */
  readonly issues: readonly string[];

  /**
   * @param issues - The issue lines.
   */
  constructor(issues: readonly string[]) {
    super("site map does not satisfy the protocol schema");
    this.name = "SiteMapBuildError";
    this.issues = issues;
  }
}

/** A polyline in metres before it is moved to the origin. */
interface Metric {
  readonly points: readonly Point[];
  readonly closed: boolean;
}

/**
 * Rounds a length to the map precision and removes the sign of zero.
 *
 * @param value - The length in metres.
 * @returns The rounded length.
 */
function round(value: number): number {
  return Math.round(value * DECIMALS) / DECIMALS + 0;
}

/**
 * Moves a metric polyline to the origin, rounds it, drops repeated positions, and closes it when it is a loop.
 *
 * @param metric - The polyline in metres.
 * @param originX - Corner shift on x.
 * @param originY - Corner shift on y.
 * @returns The cleaned positions; shorter than the minimum when the polyline degenerates.
 */
function place(metric: Metric, originX: number, originY: number): Point[] {
  const out: Point[] = [];
  for (const point of metric.points) {
    const next: Point = [round(point[0] - originX), round(point[1] - originY)];
    const last = out.at(-1);
    if (last === undefined || last[0] !== next[0] || last[1] !== next[1]) {
      out.push(next);
    }
  }
  const first = out[0];
  const last = out.at(-1);
  if (
    metric.closed &&
    first !== undefined &&
    last !== undefined &&
    (first[0] !== last[0] || first[1] !== last[1])
  ) {
    out.push(first);
  }
  return out;
}

/**
 * Returns the greatest x and y of a set of points, or zero for an empty set.
 *
 * @param points - The points.
 * @returns The corner that bounds them from the origin.
 */
function farCorner(points: readonly Point[]): Point {
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return [maxX, maxY];
}

/**
 * Scales a drawing to metres and moves its bottom-left corner to the origin.
 *
 * Walls keep every polyline, closed ones as loops. Obstacles keep closed polylines and circles as rings;
 * open ones are counted, since an open line cannot enclose a rack. A scale that is not a positive finite
 * number is a programming error, because the UI enforces the range before the call.
 *
 * @param input - The drawing, the mapping, the scale and the version (the version is not used here).
 * @returns The geometry in metres.
 * @throws RangeError When the scale is not a positive finite number.
 */
export function importGeometry(input: Omit<BuildInput, "version">): Imported {
  const { doc, mapping, metresPerUnit } = input;
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) {
    throw new RangeError("scale must be a positive, finite number");
  }

  const roles = layerRoles(mapping);
  const walls: Metric[] = [];
  const obstacles: Metric[] = [];
  let skippedOpenObstacles = 0;
  for (const entity of doc.entities) {
    const role = roles.get(entity.layer) ?? "ignore";
    if (role === "ignore") {
      continue;
    }
    for (const polyline of toPolylines(entity)) {
      const metric = scalePolyline(polyline, metresPerUnit);
      if (role === "wall") {
        walls.push(metric);
      } else if (polyline.closed) {
        obstacles.push(metric);
      } else {
        skippedOpenObstacles += 1;
      }
    }
  }

  let originX = Infinity;
  let originY = Infinity;
  for (const metric of [...walls, ...obstacles]) {
    for (const point of metric.points) {
      originX = Math.min(originX, point[0]);
      originY = Math.min(originY, point[1]);
    }
  }
  if (!Number.isFinite(originX)) {
    originX = 0;
    originY = 0;
  }

  const wallLines = walls
    .map((metric) => place(metric, originX, originY))
    .filter((points) => points.length >= 2);
  const obstacleRings = obstacles
    .map((metric) => place(metric, originX, originY))
    .filter((points) => points.length >= 4);

  const everything = [...wallLines, ...obstacleRings].flat();
  return {
    walls: wallLines,
    obstacles: obstacleRings,
    originShift: [originX, originY],
    extent: farCorner(everything),
    skippedOpenObstacles,
  };
}

/**
 * Scales one polyline to metres.
 *
 * @param polyline - The polyline in drawing units.
 * @param metresPerUnit - Metres per drawing unit.
 * @returns The polyline in metres.
 */
function scalePolyline(polyline: Polyline, metresPerUnit: number): Metric {
  return {
    points: polyline.points.map((point): Point => [
      point[0] * metresPerUnit,
      point[1] * metresPerUnit,
    ]),
    closed: polyline.closed,
  };
}

/**
 * Corners of a rectangle as a closed counter-clockwise ring.
 *
 * @param rect - The rectangle.
 * @returns Five positions, the first repeated at the end.
 */
export function rectToRing(rect: Rect): Point[] {
  const { x, y, w, h } = rect;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];
}

/**
 * Assembles the site map from the imported geometry and the operator's features, then checks it against the
 * protocol schema. The schema rejects a map without exactly one charger, without two named workstations, or
 * larger than the limits; those issues are returned, not guessed around.
 *
 * @param imported - The geometry from {@link importGeometry}.
 * @param editor - The features the operator placed.
 * @param version - The map version to write.
 * @returns The validated site map.
 * @throws {SiteMapBuildError} When the map does not satisfy the protocol schema.
 */
export function buildSiteMap(imported: Imported, editor: EditorFeatures, version: number): SiteMap {
  const features: unknown[] = [];
  for (const wall of imported.walls) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: wall },
      properties: { kind: "wall" },
    });
  }
  for (const obstacle of imported.obstacles) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [obstacle] },
      properties: { kind: "obstacle" },
    });
  }
  if (editor.charger !== null) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: editor.charger },
      properties: { kind: "charger" },
    });
  }
  for (const workstation of editor.workstations) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: workstation.at },
      properties: { kind: "workstation", name: workstation.name, size: workstation.size },
    });
  }
  for (const rect of editor.nogo) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [rectToRing(rect)] },
      properties: { kind: "nogo" },
    });
  }

  const parsed = SiteMapSchema.safeParse({
    type: "FeatureCollection",
    fleet: { crs: "local-metric", version },
    features,
  });
  if (!parsed.success) {
    throw new SiteMapBuildError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return parsed.data;
}
