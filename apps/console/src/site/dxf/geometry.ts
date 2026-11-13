/**
 * Conversion of drawn entities into polylines: arcs and circles become points, so the rest of the import
 * deals with one shape only.
 *
 * Every output position count is bounded: an arc has at most 37 positions and a circle 25, which the parser's
 * position budget already accounts for.
 */
import type { DxfEntity, Point } from "./types";

/** Largest angle between two consecutive positions of an arc, in degrees. Keeps the chord close to the arc. */
export const ARC_STEP_DEG = 10;

/** Number of positions on a circle before it is closed. */
const CIRCLE_STEPS = 24;

/** A polyline ready for the site map: its positions and whether it closes on itself. */
export interface Polyline {
  /** Positions in order. For a closed polyline the first position is not repeated at the end. */
  readonly points: readonly Point[];
  /** `true` when the polyline is a loop. */
  readonly closed: boolean;
}

/**
 * Positive remainder of a division by a modulus, so that negative angles wrap into `[0, modulus)`.
 *
 * @param value - The dividend.
 * @param modulus - The modulus, positive.
 * @returns The remainder in `[0, modulus)`.
 */
function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Approximates a counter-clockwise arc by points. An end angle at or before the start wraps to the next turn,
 * and equal angles give a full circle. Both end positions are included.
 *
 * @param center - Centre of the arc.
 * @param r - Radius, positive.
 * @param startDeg - Start angle, degrees, counter-clockwise from the x axis.
 * @param endDeg - End angle, degrees.
 * @returns The positions from start to end, at most {@link ARC_STEP_DEG} degrees apart.
 */
export function arcToPoints(center: Point, r: number, startDeg: number, endDeg: number): Point[] {
  const sweep = positiveModulo(endDeg - startDeg, 360) || 360;
  const steps = Math.max(1, Math.ceil(sweep / ARC_STEP_DEG));
  const points: Point[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = ((startDeg + (sweep * step) / steps) * Math.PI) / 180;
    points.push([center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
  }
  return points;
}

/**
 * Approximates a circle by a closed ring of {@link CIRCLE_STEPS} positions. The closing position repeats the
 * first one exactly, so the ring is a valid GeoJSON linear ring.
 *
 * @param center - Centre of the circle.
 * @param r - Radius, positive.
 * @returns The ring: 24 positions and the first one again at the end.
 */
export function circleToRing(center: Point, r: number): Point[] {
  const ring: Point[] = [];
  for (let step = 0; step < CIRCLE_STEPS; step += 1) {
    const angle = (2 * Math.PI * step) / CIRCLE_STEPS;
    ring.push([center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
  }
  const first = ring[0];
  if (first !== undefined) {
    ring.push(first);
  }
  return ring;
}

/**
 * Converts an entity into the polylines that draw it.
 *
 * @param entity - A drawn entity, in drawing units.
 * @returns One polyline per shape: a line, a polyline, a circle ring or an arc.
 */
export function toPolylines(entity: DxfEntity): Polyline[] {
  switch (entity.kind) {
    case "line":
      return [{ points: [entity.a, entity.b], closed: false }];
    case "polyline":
      return [{ points: entity.points, closed: entity.closed }];
    case "circle":
      return [{ points: circleToRing(entity.center, entity.radius), closed: true }];
    case "arc":
      return [
        {
          points: arcToPoints(entity.center, entity.radius, entity.startDeg, entity.endDeg),
          closed: false,
        },
      ];
  }
}
