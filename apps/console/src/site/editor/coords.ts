/**
 * Conversion between the pointer and the plan: the canvas is in SVG coordinates, the editor works in site metres
 * with `y` up. The flip of the plan is applied here and nowhere else in the editor.
 */
import type { Point } from "../dxf/types";
import type { ViewBox } from "../svg-paths";

/** Grid of the editor, in metres. Placed points snap to it, so a hand-typed value and a click agree. */
const GRID_STEP_M = 0.1;

/**
 * Converts a pointer position into site metres.
 *
 * The browser's screen matrix is used when it exists, because it accounts for the aspect ratio the SVG keeps.
 * Without it (a test environment, or an old browser) the position is scaled from the element's box, which is exact
 * only when the box has the aspect of the view box.
 *
 * @param svg - The plan's SVG element.
 * @param clientX - Pointer x, in client pixels.
 * @param clientY - Pointer y, in client pixels.
 * @param view - The view box the plan is drawn in.
 * @returns The position in metres, or `null` when the element has no size to measure against.
 */
export function clientToMetres(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  view: ViewBox,
): Point | null {
  // Not every environment implements the matrix (jsdom does not), so its absence is a normal case here.
  const matrix = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
  if (matrix !== null) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return [local.x, -local.y];
  }
  const box = svg.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    return null;
  }
  const svgX = view.minX + ((clientX - box.left) / box.width) * view.width;
  const svgY = view.minY + ((clientY - box.top) / box.height) * view.height;
  return [svgX, -svgY];
}

/**
 * Rounds a position to the editor grid.
 *
 * @param point - The position in metres.
 * @param step - Grid step in metres.
 * @returns The snapped position. Values are rounded to a micrometre, so the grid sums do not drift.
 */
export function snap(point: Point, step: number = GRID_STEP_M): Point {
  const round = (value: number): number =>
    Math.round(Math.round(value / step) * step * 1e6) / 1e6 + 0;
  return [round(point[0]), round(point[1])];
}
