/**
 * Geometry of the editor's resizable shapes: a workstation footprint and a no-go zone, both as a {@link Rect}.
 *
 * Pure functions with no DOM, so the resize rules are tested without a pointer. A workstation is stored as a point
 * and a size (the protocol shape); it is turned into a rectangle here, resized as a rectangle, and turned back. The
 * two kinds therefore share one implementation of every rule: minimum size, no flip, and the plan bounds.
 */
import { WORKSTATION_SIZE_MAX_M } from "@mfc/protocol";
import type { Rect, Size, Workstation } from "../dxf/build-site-map";
import type { Point } from "../dxf/types";

/** A handle of a shape: the eight points of its outline the operator can drag. */
export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Every handle, in the order the editor draws them. */
export const HANDLES: readonly Handle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/**
 * Smallest width and height a resize can produce, in metres. It is above the protocol minimum (0.1 m) and is five
 * grid steps, so a shape stays wide enough to grab once it is small.
 */
export const MIN_SHAPE_SIZE_M = 0.5;

/**
 * Largest handle hit target, in CSS pixels. WCAG 2.2 criterion 2.5.8 asks for 24 px.
 */
export const HANDLE_HIT_PX = 24;

/** Smallest handle hit target, in CSS pixels: a small feature keeps a handle that can still be grabbed. */
export const HANDLE_MIN_HIT_PX = 12;

/**
 * Edge handles of an axis are hidden when the side of the shape on that axis is shorter than this, in CSS pixels.
 * Below three handle widths the two edge handles of an axis would cover most of its side, so only the corners and
 * the other axis stay.
 */
export const EDGE_HANDLES_MIN_SIDE_PX = 3 * HANDLE_HIT_PX;

/**
 * A handle grabs at most one share of the longest side of its shape, so the body of a small shape stays clickable.
 */
const HANDLE_SIDE_SHARE = 3;

/**
 * Micrometres per metre. Stored coordinates are rounded to this precision, so repeated arithmetic (a keyboard step
 * of 0.1 m, ten times) does not leave float noise in the saved map.
 */
const MICROMETRES_PER_METRE = 1e6;

/**
 * Limits applied to a shape. The plan bounds keep the shape on the plan; the size bounds keep it usable.
 */
export interface Limits {
  /** Far corner of the plan, in metres; the plan starts at the origin. `null` before the import: no clamp. */
  readonly bounds: Point | null;
  /** Smallest width and height, in metres. */
  readonly min: number;
  /** Largest width and height, in metres. */
  readonly max: number;
}

/**
 * Which edge of a shape a handle moves on one axis. `start` is the west or south edge, `end` the east or north edge,
 * and `null` means the handle does not move that axis.
 */
type Side = "start" | "end" | null;

/** A span of one axis: where it starts and how long it is. */
interface Span {
  readonly start: number;
  readonly length: number;
}

/** The range a span must stay in on one axis. Infinite when the plan is not known. */
interface AxisRange {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Clamps a value into a closed range.
 *
 * @param value - The value.
 * @param lo - Lower bound, inclusive.
 * @param hi - Upper bound, inclusive.
 * @returns The value, or the nearest bound.
 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Rounds a length to the micrometre. The `+ 0` turns a negative zero into a zero, so equal shapes compare equal.
 *
 * @param value - The length in metres.
 * @returns The rounded length.
 */
function roundMicro(value: number): number {
  return Math.round(value * MICROMETRES_PER_METRE) / MICROMETRES_PER_METRE + 0;
}

/**
 * The range of one axis of the plan.
 *
 * @param bounds - Far corner of the plan, or `null` when unknown.
 * @param axis - `"x"` or `"y"`.
 * @returns The range from the origin to the plan edge, or an unbounded range.
 */
function axisRange(bounds: Point | null, axis: "x" | "y"): AxisRange {
  if (bounds === null) {
    return { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY };
  }
  const [maxX, maxY] = bounds;
  return { lo: 0, hi: axis === "x" ? maxX : maxY };
}

/**
 * The edges a handle moves on each axis.
 *
 * @param handle - The handle.
 * @returns The sides on x and y.
 */
function movingSides(handle: Handle): { readonly x: Side; readonly y: Side } {
  switch (handle) {
    case "n":
      return { x: null, y: "end" };
    case "ne":
      return { x: "end", y: "end" };
    case "e":
      return { x: "end", y: null };
    case "se":
      return { x: "end", y: "start" };
    case "s":
      return { x: null, y: "start" };
    case "sw":
      return { x: "start", y: "start" };
    case "w":
      return { x: "start", y: null };
    case "nw":
      return { x: "start", y: "end" };
  }
}

/**
 * Moves the edge of one axis that a handle names, to the target, within the size and plan limits. The opposite edge
 * never moves. The edge stops at the minimum size rather than crossing the opposite edge, so a shape never flips.
 *
 * The size limits are applied first and the plan bounds last, so the plan wins when both cannot hold: a shape is
 * never moved outside the plan by a resize. An edge that already lies outside the plan can only be pulled back to its
 * own position, never past it.
 *
 * @param span - The span before the move.
 * @param side - The edge to move, or `null` when the axis does not move.
 * @param target - Where the moving edge should go, in metres.
 * @param limits - The size and plan limits.
 * @param range - The plan range of this axis.
 * @returns The span after the move.
 */
function resizeSpan(
  span: Span,
  side: Side,
  target: number,
  limits: Limits,
  range: AxisRange,
): Span {
  if (side === null) {
    return span;
  }
  const end = span.start + span.length;
  if (side === "end") {
    const sized = clamp(target, span.start + limits.min, span.start + limits.max);
    const edge = Math.min(sized, Math.max(range.hi, span.start));
    return { start: span.start, length: roundMicro(edge - span.start) };
  }
  const sized = clamp(target, end - limits.max, end - limits.min);
  const start = roundMicro(Math.max(sized, Math.min(range.lo, end)));
  return { start, length: roundMicro(end - start) };
}

/**
 * Fits a span into the size limits and the plan range without moving its opposite edge.
 *
 * @param span - The span to fit.
 * @param range - The plan range of this axis.
 * @param limits - The size and plan limits.
 * @returns The fitted span. A span longer than the plan is pinned to the start of the plan.
 */
function fitSpan(span: Span, range: AxisRange, limits: Limits): Span {
  const length = clamp(span.length, limits.min, limits.max);
  const start = clamp(span.start, range.lo, Math.max(range.lo, range.hi - length));
  return { start, length };
}

/**
 * Coordinate of a handle on one axis: the edge it moves, or the middle when it does not move that axis.
 *
 * @param start - Start of the span.
 * @param length - Length of the span.
 * @param side - The edge the handle moves on this axis, or `null`.
 * @returns The coordinate in metres.
 */
function handleCoordinate(start: number, length: number, side: Side): number {
  if (side === "start") {
    return start;
  }
  if (side === "end") {
    return start + length;
  }
  return start + length / 2;
}

/**
 * Tells whether two rectangles have the same position and size.
 *
 * @param a - The first rectangle.
 * @param b - The second rectangle.
 * @returns `true` when every field is equal.
 */
export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * The rectangle of a workstation footprint: the workstation point is its centre.
 *
 * @param workstation - The workstation.
 * @returns The footprint in metres, lower-left corner first.
 */
export function workstationRect(workstation: Workstation): Rect {
  const { width, height } = workstation.size;
  return {
    x: workstation.at[0] - width / 2,
    y: workstation.at[1] - height / 2,
    w: width,
    h: height,
  };
}

/**
 * Puts a rectangle back on a workstation: the centre becomes the point, and the sides become the size.
 *
 * @param workstation - The workstation, whose name is kept.
 * @param rect - The new footprint.
 * @returns The workstation with its new point and size.
 */
export function withWorkstationRect(workstation: Workstation, rect: Rect): Workstation {
  const at: Point = [roundMicro(rect.x + rect.w / 2), roundMicro(rect.y + rect.h / 2)];
  const size: Size = { width: roundMicro(rect.w), height: roundMicro(rect.h) };
  return { ...workstation, at, size };
}

/**
 * The point a handle sits on: a corner, an edge midpoint, or the matching edge coordinates.
 *
 * @param rect - The shape.
 * @param handle - The handle.
 * @returns The position in metres.
 */
export function handlePoint(rect: Rect, handle: Handle): Point {
  const sides = movingSides(handle);
  return [handleCoordinate(rect.x, rect.w, sides.x), handleCoordinate(rect.y, rect.h, sides.y)];
}

/**
 * Resizes a shape by dragging one handle to a position. Only the edges the handle names move, to the target; the
 * opposite edges stay fixed. A corner moves two edges, an edge handle moves one.
 *
 * The result respects the limits: the moved edge stops at the minimum size, at the maximum size, and inside the
 * plan. It never flips. The function is idempotent: applying the same handle and target twice gives the same
 * rectangle as applying it once, so a replayed pointer event cannot drift the shape. A non-finite target leaves the
 * shape unchanged.
 *
 * @param rect - The shape, normalised (positive width and height).
 * @param handle - The handle being dragged.
 * @param to - The target position of the handle, in metres.
 * @param limits - The size and plan limits.
 * @returns The resized shape, normalised.
 */
export function resizeRect(rect: Rect, handle: Handle, to: Point, limits: Limits): Rect {
  if (!Number.isFinite(to[0]) || !Number.isFinite(to[1])) {
    return rect;
  }
  const sides = movingSides(handle);
  const x = resizeSpan(
    { start: rect.x, length: rect.w },
    sides.x,
    to[0],
    limits,
    axisRange(limits.bounds, "x"),
  );
  const y = resizeSpan(
    { start: rect.y, length: rect.h },
    sides.y,
    to[1],
    limits,
    axisRange(limits.bounds, "y"),
  );
  return { x: x.start, y: y.start, w: x.length, h: y.length };
}

/**
 * Grows or shrinks a shape from its east and north edges, by an offset. The lower-left corner stays fixed; this is
 * the keyboard resize, one grid step per key press.
 *
 * @param rect - The shape, normalised.
 * @param dw - Change of the width, in metres; negative shrinks.
 * @param dh - Change of the height, in metres; negative shrinks.
 * @param limits - The size and plan limits.
 * @returns The resized shape.
 */
export function growRect(rect: Rect, dw: number, dh: number, limits: Limits): Rect {
  return resizeRect(rect, "ne", [rect.x + rect.w + dw, rect.y + rect.h + dh], limits);
}

/**
 * Puts a whole shape within the size and plan limits, so that no value set from outside can break an invariant. A
 * cancelled drag does not use it: it restores the stored footprint as it was, see `restoreShape` in the reducer.
 *
 * @param rect - The shape.
 * @param limits - The size and plan limits.
 * @returns The shape, within the limits.
 */
export function fitRect(rect: Rect, limits: Limits): Rect {
  const x = fitSpan({ start: rect.x, length: rect.w }, axisRange(limits.bounds, "x"), limits);
  const y = fitSpan({ start: rect.y, length: rect.h }, axisRange(limits.bounds, "y"), limits);
  return { x: x.start, y: y.start, w: x.length, h: y.length };
}

/**
 * The limits of a kind of shape. A workstation footprint is capped at the protocol maximum; a no-go zone has no cap.
 *
 * @param kind - The kind of shape.
 * @param extent - Far corner of the imported plan, or `null` before the import.
 * @returns The limits.
 */
export function limitsFor(kind: "workstation" | "nogo", extent: Point | null): Limits {
  return {
    bounds: extent,
    min: MIN_SHAPE_SIZE_M,
    max: kind === "workstation" ? WORKSTATION_SIZE_MAX_M : Number.POSITIVE_INFINITY,
  };
}

/**
 * The handles to draw on a shape. On an axis whose side is too short on the screen, the two edge handles of that
 * axis are hidden, so the remaining handles do not overlap. Both sides short leaves the four corners.
 *
 * @param rect - The shape.
 * @param pxPerM - Screen pixels per metre.
 * @returns The handles to draw, in the order of {@link HANDLES}.
 */
export function visibleHandles(rect: Rect, pxPerM: number): readonly Handle[] {
  const narrow = rect.w * pxPerM < EDGE_HANDLES_MIN_SIDE_PX;
  const short = rect.h * pxPerM < EDGE_HANDLES_MIN_SIDE_PX;
  return HANDLES.filter(
    (handle) =>
      !(
        (narrow && (handle === "e" || handle === "w")) ||
        (short && (handle === "n" || handle === "s"))
      ),
  );
}

/**
 * Side of the square hit target of a handle, in CSS pixels: a share of the longest side of the shape, kept between
 * the minimum and the maximum target.
 *
 * @param rect - The shape.
 * @param pxPerM - Screen pixels per metre.
 * @returns The hit target side, in CSS pixels.
 */
export function handleHitPx(rect: Rect, pxPerM: number): number {
  const longest = Math.max(rect.w, rect.h) * pxPerM;
  return clamp(longest / HANDLE_SIDE_SHARE, HANDLE_MIN_HIT_PX, HANDLE_HIT_PX);
}
