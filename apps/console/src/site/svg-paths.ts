/**
 * SVG path and viewBox helpers of the site map view. Pure string and number work, so the drawing rules are
 * tested without a DOM.
 *
 * The values come from a validated site map or from the import, so they are finite numbers; no text from a
 * file is ever written into a path.
 */
import type { Point } from "./dxf/types";

/** Bounds of a set of points, as an SVG viewBox origin and size. */
export interface ViewBox {
  /** Smallest x. */
  readonly minX: number;
  /** Smallest y. */
  readonly minY: number;
  /** Extent along x. */
  readonly width: number;
  /** Extent along y. */
  readonly height: number;
}

/**
 * Path data of an open polyline: a move to the first position, then lines to the others.
 *
 * @param points - The positions.
 * @returns The path data, empty for no positions.
 */
export function lineToPath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${String(point[0])} ${String(point[1])}`)
    .join(" ");
}

/**
 * Path data of a closed ring.
 *
 * @param points - The positions of the ring.
 * @returns The path data, closed with `Z`; empty for no positions.
 */
export function ringToPath(points: readonly Point[]): string {
  const open = lineToPath(points);
  return open === "" ? "" : `${open} Z`;
}

/**
 * Smallest box that holds every position.
 *
 * @param points - The positions.
 * @returns The box; all zeros for no positions.
 */
export function computeViewBox(points: readonly Point[]): ViewBox {
  const first = points[0];
  if (first === undefined) {
    return { minX: 0, minY: 0, width: 0, height: 0 };
  }
  let minX = first[0];
  let minY = first[1];
  let maxX = first[0];
  let maxY = first[1];
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}
