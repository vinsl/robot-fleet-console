/**
 * Pure geometry of the fleet map: site metres to screen pixels, through the content fit, the zoom and pan of the
 * viewport, and the tilt of the plane in perspective.
 *
 * Nothing here reads the DOM. The tilt and the perspective are the same values the CSS uses (`tokens.map`), and
 * the transform origin of the plane is `50% 60%` in the stylesheet, so the projection and the drawing agree.
 *
 * Coordinates, from the outside in:
 * - site: metres, `y` up;
 * - content: pixels of the plane, the map drawn in its fitted box (SVG viewBox flipped to `y` down);
 * - view: content after zoom and pan about the content centre;
 * - stage: pixels of the stage, after the tilt and the perspective.
 */
import { map } from "../../theme/tokens";
import type { ViewBox } from "../../site/svg-paths";

/** A point in one of the coordinate systems above. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Untransformed layout of the plane inside the stage, with its transform origin and tilt.
 *
 * The plane is the box that the map is fitted in. `planeLeft` and `planeTop` are its offsets inside the stage.
 */
export interface PlaneGeometry {
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly planeLeft: number;
  readonly planeTop: number;
  readonly planeWidth: number;
  readonly planeHeight: number;
  /** Transform origin of the plane, in plane pixels. */
  readonly originX: number;
  readonly originY: number;
  /** Tilt about the x axis, in radians. Zero is the flat view. */
  readonly tiltRad: number;
  /** Distance of the eye from the plane, in pixels (the CSS `perspective`). */
  readonly perspectivePx: number;
}

/**
 * The box the map content occupies inside the plane (fitted and centred, aspect preserved), and the SVG viewBox it
 * shows. Left and top are in plane pixels.
 */
export interface ContentFrame {
  readonly viewBox: ViewBox;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Zoom and pan of the viewport. Pan is in plane pixels, applied after the zoom. */
export interface ViewTransform {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

/** The untouched view: no zoom, no pan. */
export const IDENTITY_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/**
 * Fits the map box in the plane, keeping its aspect ratio, and centres it.
 *
 * @param viewBox - The bounds of the map, in SVG user units.
 * @param planeWidth - Width of the plane, in pixels.
 * @param planeHeight - Height of the plane, in pixels.
 * @returns The content frame.
 */
export function fitContent(
  viewBox: ViewBox,
  planeWidth: number,
  planeHeight: number,
): ContentFrame {
  const scale = Math.min(planeWidth / viewBox.width, planeHeight / viewBox.height);
  const width = viewBox.width * scale;
  const height = viewBox.height * scale;
  return {
    viewBox,
    left: (planeWidth - width) / 2,
    top: (planeHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Maps a site point (metres, `y` up) to content pixels. The viewBox is flipped on `y`, as the map drawing is.
 *
 * @param p - The site point.
 * @param frame - The content frame.
 * @returns The point in plane pixels.
 */
export function siteToContent(p: Point2, frame: ContentFrame): Point2 {
  const { viewBox } = frame;
  return {
    x: frame.left + ((p.x - viewBox.minX) * frame.width) / viewBox.width,
    y: frame.top + ((-p.y - viewBox.minY) * frame.height) / viewBox.height,
  };
}

/**
 * Centre of the content frame, in plane pixels. Zoom happens about this point.
 *
 * @param frame - The content frame.
 * @returns The centre.
 */
function contentCentre(frame: ContentFrame): Point2 {
  return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
}

/**
 * Applies the zoom and the pan to a plane point: zoom about the content centre, then pan.
 *
 * @param p - A point in plane pixels.
 * @param frame - The content frame.
 * @param view - The zoom and pan.
 * @returns The point after the view, in plane pixels.
 */
export function applyView(p: Point2, frame: ContentFrame, view: ViewTransform): Point2 {
  const c = contentCentre(frame);
  return {
    x: c.x + (p.x - c.x) * view.zoom + view.panX,
    y: c.y + (p.y - c.y) * view.zoom + view.panY,
  };
}

/**
 * Projects a plane point to the stage: rotation about the x axis through the transform origin, then the
 * perspective about the stage centre.
 *
 * With `tiltRad > 0`, points above the origin recede (their depth is negative, so they scale towards the centre).
 *
 * @param p - A point in plane pixels.
 * @param plane - The plane geometry.
 * @returns The point in stage pixels.
 */
export function projectPlanePoint(p: Point2, plane: PlaneGeometry): Point2 {
  const cos = Math.cos(plane.tiltRad);
  const sin = Math.sin(plane.tiltRad);
  const dx = p.x - plane.originX;
  const dy = p.y - plane.originY;
  const x = plane.planeLeft + plane.originX + dx;
  const y = plane.planeTop + plane.originY + dy * cos;
  const depth = dy * sin;
  const scale = plane.perspectivePx / (plane.perspectivePx - depth);
  const cx = plane.stageWidth / 2;
  const cy = plane.stageHeight / 2;
  return { x: cx + (x - cx) * scale, y: cy + (y - cy) * scale };
}

/**
 * Inverse of {@link projectPlanePoint} for points on the plane (depth zero before the tilt).
 *
 * @param screen - A point in stage pixels.
 * @param plane - The plane geometry.
 * @returns The point in plane pixels.
 */
export function unprojectToPlane(screen: Point2, plane: PlaneGeometry): Point2 {
  const cos = Math.cos(plane.tiltRad);
  const sin = Math.sin(plane.tiltRad);
  const persp = plane.perspectivePx;
  const cx = plane.stageWidth / 2;
  const cy = plane.stageHeight / 2;
  const k = screen.y - cy;
  const a = plane.planeTop + plane.originY - cy;
  const dy = (persp * (k - a)) / (persp * cos + k * sin);
  const scale = persp / (persp - dy * sin);
  const dx = (screen.x - cx) / scale - (plane.planeLeft + plane.originX - cx);
  return { x: plane.originX + dx, y: plane.originY + dy };
}

/**
 * Maps a site point all the way to the stage: content, view, then tilt and perspective.
 *
 * @param p - The site point, in metres.
 * @param frame - The content frame.
 * @param view - The zoom and pan.
 * @param plane - The plane geometry.
 * @returns The point in stage pixels.
 */
export function siteToScreen(
  p: Point2,
  frame: ContentFrame,
  view: ViewTransform,
  plane: PlaneGeometry,
): Point2 {
  return projectPlanePoint(applyView(siteToContent(p, frame), frame, view), plane);
}

/**
 * Screen angle of a site heading, read by projecting a probe point {@link map.headingProbeM} ahead of the robot.
 *
 * The angle is in radians, measured from the screen's x axis, clockwise positive (the screen's `y` points down).
 * A robot heading up the screen therefore reads as `-pi / 2`.
 *
 * @param p - The robot position, in site metres.
 * @param headingRad - The site heading, in radians, from the `x` axis towards `y`.
 * @param frame - The content frame.
 * @param view - The zoom and pan.
 * @param plane - The plane geometry.
 * @returns The screen angle, in radians.
 */
export function screenHeading(
  p: Point2,
  headingRad: number,
  frame: ContentFrame,
  view: ViewTransform,
  plane: PlaneGeometry,
): number {
  const probe: Point2 = {
    x: p.x + map.headingProbeM * Math.cos(headingRad),
    y: p.y + map.headingProbeM * Math.sin(headingRad),
  };
  const from = siteToScreen(p, frame, view, plane);
  const to = siteToScreen(probe, frame, view, plane);
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * Zooms by a factor, keeping the plane point `anchor` under the same screen position. The result is clamped to
 * the zoom bounds of the map.
 *
 * @param view - The current zoom and pan.
 * @param factor - Multiplicative change of the zoom.
 * @param anchor - The plane point to keep fixed, in plane pixels.
 * @param frame - The content frame.
 * @returns The new view.
 */
export function zoomAt(
  view: ViewTransform,
  factor: number,
  anchor: Point2,
  frame: ContentFrame,
): ViewTransform {
  const zoom = Math.min(map.zoomMax, Math.max(map.zoomMin, view.zoom * factor));
  const ratio = zoom / view.zoom;
  const c = contentCentre(frame);
  return {
    zoom,
    panX: view.panX + (anchor.x - c.x - view.panX) * (1 - ratio),
    panY: view.panY + (anchor.y - c.y - view.panY) * (1 - ratio),
  };
}

/**
 * Pans by a screen delta. On a tilted plane a vertical screen move covers less plane distance, so `dy` is divided
 * by the cosine of the tilt.
 *
 * @param view - The current zoom and pan.
 * @param dx - Horizontal move of the pointer, in pixels.
 * @param dy - Vertical move of the pointer, in pixels.
 * @param plane - The plane geometry, for the tilt.
 * @returns The new view.
 */
export function panBy(
  view: ViewTransform,
  dx: number,
  dy: number,
  plane: PlaneGeometry,
): ViewTransform {
  return {
    zoom: view.zoom,
    panX: view.panX + dx,
    panY: view.panY + dy / Math.cos(plane.tiltRad),
  };
}

/**
 * The view that puts a site point at the centre of the content, at the current zoom.
 *
 * @param view - The current view, whose zoom is kept.
 * @param p - The site point, in metres.
 * @param frame - The content frame.
 * @returns The new view.
 */
export function centreOn(view: ViewTransform, p: Point2, frame: ContentFrame): ViewTransform {
  const q = siteToContent(p, frame);
  const c = contentCentre(frame);
  return {
    zoom: view.zoom,
    panX: -(q.x - c.x) * view.zoom,
    panY: -(q.y - c.y) * view.zoom,
  };
}

/**
 * Linear interpolation between two views, for an animated move.
 *
 * @param from - The view at the start.
 * @param to - The view at the end.
 * @param u - Progress, from 0 (start) to 1 (end).
 * @returns The view in between.
 */
export function interpolateView(from: ViewTransform, to: ViewTransform, u: number): ViewTransform {
  return {
    zoom: from.zoom + (to.zoom - from.zoom) * u,
    panX: from.panX + (to.panX - from.panX) * u,
    panY: from.panY + (to.panY - from.panY) * u,
  };
}
