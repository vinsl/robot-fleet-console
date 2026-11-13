/**
 * Interaction geometry of the editor's features: how large a clickable shape must be on the screen, whatever the
 * scale of the plan. Pure functions with no DOM, so the sizes are tested without rendering.
 *
 * These are interaction constants, not visual ones: the visible shapes keep their size, and only the transparent
 * shapes that receive the pointer are inflated to the minimum target.
 */
import type { Rect } from "../dxf/build-site-map";
import type { Point } from "../dxf/types";

/**
 * Smallest side of a pointer target on the screen, in CSS pixels. It is the touch and pointer target size the
 * accessibility guidelines ask for (WCAG 2.2 criterion 2.5.8 sets 24 px; 44 px is the usual design target).
 */
export const HIT_TARGET_PX = 44;

/**
 * Width of the plan in pixels when it cannot be measured (no layout yet, or a test without a layout engine). The
 * fallback keeps the hit targets deterministic in those environments.
 */
export const FALLBACK_VIEW_PX = 800;

/**
 * Number of screen pixels per site metre.
 *
 * @param widthPx - Measured width of the plan on the screen, in pixels; `0` when it is not measured yet.
 * @param viewWidthM - Width of the view box, in site metres.
 * @returns The pixels per metre, from the measured width or from the fallback width.
 */
export function pxPerMetre(widthPx: number, viewWidthM: number): number {
  if (widthPx > 0 && viewWidthM > 0) {
    return widthPx / viewWidthM;
  }
  return FALLBACK_VIEW_PX / Math.max(viewWidthM, Number.EPSILON);
}

/**
 * The smallest side, in metres, that a pointer target needs to reach {@link HIT_TARGET_PX} on the screen.
 *
 * @param pxPerM - Screen pixels per site metre.
 * @returns The side in metres.
 */
export function minTargetM(pxPerM: number): number {
  return HIT_TARGET_PX / pxPerM;
}

/**
 * Inflates a rectangle about its centre so that each side is at least `minSideM`. A rectangle already larger than
 * that is returned at its size: a target never shrinks.
 *
 * @param rect - The visible rectangle, in site metres.
 * @param minSideM - The smallest side, in metres.
 * @returns The pointer target, with the same centre.
 */
export function hitRect(rect: Rect, minSideM: number): Rect {
  const w = Math.max(rect.w, minSideM);
  const h = Math.max(rect.h, minSideM);
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;
  return { x: centreX - w / 2, y: centreY - h / 2, w, h };
}

/**
 * A square pointer target centred on a point, for a feature that is a point marker.
 *
 * @param at - The position of the marker, in site metres.
 * @param minSideM - The side of the square, in metres.
 * @returns The square.
 */
export function hitSquareAt(at: Point, minSideM: number): Rect {
  return { x: at[0] - minSideM / 2, y: at[1] - minSideM / 2, w: minSideM, h: minSideM };
}
