/**
 * Geometry of a site plan as the view draws it: the features grouped by how they are drawn, the size of a marker,
 * and the view box that frames them. Pure data with no DOM, so the mapping from GeoJSON to shapes is tested
 * without rendering.
 *
 * The plan is drawn in a flipped group (`y` up in the site frame, `y` down in SVG). The view box returned here is
 * already in SVG coordinates, so the caller needs no conversion of its own.
 *
 * Markers and labels are sized from the plan width, so the drawing reads the same at any scale. The label metrics
 * are declared once, here: the view box must leave room for the labels that the renderer places, and both sides
 * read the same numbers.
 */
import type { SiteMap } from "@mfc/protocol";
import type { Point } from "../dxf/types";
import { computeViewBox, type ViewBox } from "../svg-paths";

/** Margin around the features in the view, in metres. Keeps outline strokes inside the frame. */
export const VIEW_PADDING_M = 2;

/**
 * The plan is this many marker sizes across. Markers and labels scale with the plan width, so a 20 m warehouse
 * and a 200 m warehouse show their markers at the same relative size.
 */
export const PLAN_UNITS_ACROSS = 60;

/**
 * Size of the labels, in marker units. Read by the renderer and by the clearance below.
 */
export const LABEL_SIZE_UNITS = 1.2;

/**
 * Distance from a workstation to the baseline of its label, in marker units. The label sits under the square, so
 * the value is the square's half-size plus the label's first line.
 */
export const WORKSTATION_LABEL_OFFSET_UNITS = 1.4;

/**
 * Distance from the charger to the baseline of its label, in marker units. It sits below the bolt, which is two
 * units tall, so this places the label under the icon.
 */
export const CHARGER_LABEL_OFFSET_UNITS = 1.6;

/**
 * Clearance the view keeps around the features, in marker units. A label hangs below its anchor by its offset
 * plus its size, which the largest offset and the label size bound at 2.8 units; 3 units keeps every label, and the
 * charger icon, inside the frame. The renderer also lets the overflow show, so a long name is never cut.
 */
export const LABEL_CLEARANCE_UNITS = 3;

/**
 * Width of the halo drawn around a label, in marker units: a 0.25 unit halo around a 1.2 unit font. It is an SVG
 * attribute, not a CSS length, because a CSS `px` width on a plan is a user unit, which here is a metre; in marker
 * units the halo scales with the plan like the text does.
 */
export const LABEL_HALO_UNITS = 0.25;

/**
 * Width of a hatch line in a no-go zone, in marker units. Given as an attribute for the same reason as the label
 * halo: a width in metres makes the hatch a solid slab.
 */
export const HATCH_STROKE_UNITS = 0.08;

/**
 * How far the baseline of a label under a sized workstation is tucked up into the clearance of its footprint, in
 * marker units. The label is one line of {@link LABEL_SIZE_UNITS}, but its capitals reach only most of that height,
 * so the baseline sits this much less than the full line below the footprint edge.
 */
const LABEL_FOOTPRINT_TUCK_UNITS = 0.2;

/** Side of the plan when there is nothing to draw, in metres. A fixed frame keeps the empty view readable. */
const EMPTY_PLAN_M = 10;

/** A workstation and where it stands, in the site frame. */
export interface WorkstationMarker {
  /** Name of the workstation: a validated slug, safe to show as text. */
  readonly name: string;
  /** Position in metres, in the site frame: the centre of the footprint, and the mission target. */
  readonly at: Point;
  /** Footprint in metres, centred on `at`; `null` for a point marker without a footprint. */
  readonly size: { readonly width: number; readonly height: number } | null;
}

/** The features of a plan, grouped by how they are drawn. */
export interface FeatureLayers {
  /** Each wall as an open polyline. */
  readonly walls: readonly (readonly Point[])[];
  /** Each obstacle as one closed ring. */
  readonly obstacles: readonly (readonly Point[])[];
  /** Each no-go zone as one closed ring. */
  readonly nogo: readonly (readonly Point[])[];
  /** The charger position, or `null` when the plan has none. A validated map always has one. */
  readonly charger: Point | null;
  /** The workstations, in file order. */
  readonly workstations: readonly WorkstationMarker[];
}

/**
 * Groups the features of a validated map by how they are drawn.
 *
 * The narrowing is on the geometry, which the schema ties to each kind, so a polygon can only ever be read as
 * a ring and a point only as a position.
 *
 * @param map - A validated site map.
 * @returns The grouped features.
 */
export function featureLayers(map: SiteMap): FeatureLayers {
  const walls: Point[][] = [];
  const obstacles: Point[][] = [];
  const nogo: Point[][] = [];
  const workstations: WorkstationMarker[] = [];
  let charger: Point | null = null;

  for (const feature of map.features) {
    const { geometry, properties } = feature;
    switch (properties.kind) {
      case "wall":
        if (geometry.type === "LineString") {
          walls.push([...geometry.coordinates]);
        }
        break;
      case "obstacle":
        if (geometry.type === "Polygon") {
          obstacles.push([...geometry.coordinates[0]]);
        }
        break;
      case "nogo":
        if (geometry.type === "Polygon") {
          nogo.push([...geometry.coordinates[0]]);
        }
        break;
      case "charger":
        if (geometry.type === "Point") {
          charger = geometry.coordinates;
        }
        break;
      case "workstation":
        if (geometry.type === "Point") {
          workstations.push({
            name: properties.name,
            at: geometry.coordinates,
            size: properties.size ?? null,
          });
        }
        break;
    }
  }

  return { walls, obstacles, nogo, charger, workstations };
}

/**
 * The points that a workstation occupies in the frame: its centre, or the four corners of its footprint.
 *
 * The corners count so that a footprint at the edge of the plan is framed, not cut.
 *
 * @param workstation - The workstation.
 * @returns The points, in site metres.
 */
function workstationPoints(workstation: WorkstationMarker): readonly Point[] {
  const [x, y] = workstation.at;
  if (workstation.size === null) {
    return [workstation.at];
  }
  const halfWidth = workstation.size.width / 2;
  const halfHeight = workstation.size.height / 2;
  return [
    [x - halfWidth, y - halfHeight],
    [x + halfWidth, y - halfHeight],
    [x + halfWidth, y + halfHeight],
    [x - halfWidth, y + halfHeight],
  ];
}

/**
 * Bounds of every feature in the site frame, without padding.
 *
 * @param layers - The grouped features.
 * @returns The bounds, or `null` when there is no feature.
 */
function featureBounds(layers: FeatureLayers): ViewBox | null {
  const points: Point[] = [
    ...layers.walls.flat(),
    ...layers.obstacles.flat(),
    ...layers.nogo.flat(),
    ...(layers.charger === null ? [] : [layers.charger]),
    ...layers.workstations.flatMap(workstationPoints),
  ];
  return points.length === 0 ? null : computeViewBox(points);
}

/**
 * Distance from a workstation to the baseline of its label.
 *
 * A point marker keeps the fixed offset. A workstation with a footprint takes the label below its edge, so the label
 * never lies on the footprint, and never sits closer than the fixed offset.
 *
 * @param unit - Size of one marker unit, in site metres.
 * @param size - The footprint of the workstation, or `null` for a point marker.
 * @returns The offset in site metres, positive: the label is drawn below the anchor by this much.
 */
export function stationLabelOffset(unit: number, size: WorkstationMarker["size"]): number {
  const fixed = WORKSTATION_LABEL_OFFSET_UNITS * unit;
  if (size === null) {
    return fixed;
  }
  return Math.max(fixed, size.height / 2 + (LABEL_SIZE_UNITS - LABEL_FOOTPRINT_TUCK_UNITS) * unit);
}

/**
 * Size of one marker, in site metres: the plan width split into {@link PLAN_UNITS_ACROSS} units.
 *
 * The width is taken from the features alone, not from the padded view, so the marker size does not depend on
 * the padding it causes. An empty plan uses the fixed frame.
 *
 * @param layers - The grouped features.
 * @returns The marker size in metres.
 */
export function markerUnit(layers: FeatureLayers): number {
  const bounds = featureBounds(layers);
  const width = bounds === null ? EMPTY_PLAN_M : bounds.width;
  return width / PLAN_UNITS_ACROSS;
}

/**
 * The view box that frames every feature, in SVG coordinates (the `y` axis is flipped), with the padding.
 *
 * The padding is the larger of {@link VIEW_PADDING_M} and {@link LABEL_CLEARANCE_UNITS} marker units, so that the
 * labels of a large plan (200 m and more) are not cut at the edge. An empty plan gets a fixed frame rather than a
 * zero-sized one, so the view never divides by zero.
 *
 * @param layers - The grouped features.
 * @returns The view box, ready for a `viewBox` attribute.
 */
export function mapViewBox(layers: FeatureLayers): ViewBox {
  const bounds = featureBounds(layers);
  if (bounds === null) {
    return { minX: 0, minY: 0, width: EMPTY_PLAN_M, height: EMPTY_PLAN_M };
  }
  const padding = Math.max(
    VIEW_PADDING_M,
    LABEL_CLEARANCE_UNITS * (bounds.width / PLAN_UNITS_ACROSS),
  );
  // The plan is drawn with `y` negated, so the top edge of the frame is the negated lowest site `y`.
  return {
    minX: bounds.minX - padding,
    minY: -(bounds.minY + bounds.height) - padding,
    width: bounds.width + 2 * padding,
    height: bounds.height + 2 * padding,
  };
}
