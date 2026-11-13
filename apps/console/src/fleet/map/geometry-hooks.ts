/**
 * Layout hooks of the fleet map: the geometry of the tilted plane, measured once per resize, and the compact tilt
 * of small screens.
 *
 * Measurements come from the layout only through ResizeObserver, never inside the marker animation loop.
 */
import { useEffect, useState, type RefObject } from "react";
import { breakpoint, map } from "../../theme/tokens";
import type { PlaneGeometry } from "./projection";

/**
 * Transform origin of the plane, as a fraction of its box. Must match `transform-origin: 50% 60%` in
 * `FleetMap.module.css`, otherwise the projected markers drift off the drawing.
 */
const ORIGIN_X_RATIO = 0.5;
const ORIGIN_Y_RATIO = 0.6;

/** Degrees to radians. */
const DEG_TO_RAD = Math.PI / 180;

/** Media query of the compact layout, the same one as the stylesheets use (ADR 0075): narrow or short. */
const COMPACT_QUERY = `(max-width: ${String(breakpoint.phone - 1)}px), (max-height: ${String(breakpoint.compactHeight)}px)`;

/**
 * Tells whether a media query matches. Returns `false` where `matchMedia` does not exist (no browser).
 *
 * @param query - The media query.
 * @returns Whether the query matches now.
 */
function mediaMatches(query: string): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

/**
 * Measures the plane and keeps the measurement up to date while the stage or the plane resizes.
 *
 * @param stage - The stage element, the positioned parent of the plane.
 * @param plane - The plane element, rotated by the caller.
 * @param tiltDeg - The tilt in degrees; zero for the flat view.
 * @returns The geometry, or `null` before the first layout (no size yet).
 */
export function usePlaneGeometry(
  stage: RefObject<HTMLElement | null>,
  plane: RefObject<HTMLElement | null>,
  tiltDeg: number,
): PlaneGeometry | null {
  const [geometry, setGeometry] = useState<PlaneGeometry | null>(null);
  useEffect(() => {
    const stageElement = stage.current;
    const planeElement = plane.current;
    if (stageElement === null || planeElement === null) {
      return;
    }
    const measure = (): void => {
      const stageWidth = stageElement.clientWidth;
      const stageHeight = stageElement.clientHeight;
      const planeWidth = planeElement.offsetWidth;
      const planeHeight = planeElement.offsetHeight;
      // Not laid out yet, or hidden: keep the previous geometry rather than divide by zero later.
      if (stageWidth === 0 || stageHeight === 0 || planeWidth === 0 || planeHeight === 0) {
        return;
      }
      setGeometry({
        stageWidth,
        stageHeight,
        // The plane is positioned inside the stage, so its offsets are relative to the stage.
        planeLeft: planeElement.offsetLeft,
        planeTop: planeElement.offsetTop,
        planeWidth,
        planeHeight,
        originX: planeWidth * ORIGIN_X_RATIO,
        originY: planeHeight * ORIGIN_Y_RATIO,
        tiltRad: tiltDeg * DEG_TO_RAD,
        perspectivePx: map.perspectivePx,
      });
    };
    // Without an observer (old browsers, jsdom) the window resize is the only signal left.
    if (typeof window.ResizeObserver !== "function") {
      measure();
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stageElement);
    observer.observe(planeElement);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [stage, plane, tiltDeg]);
  return geometry;
}

/**
 * Tells whether the screen is compact, so that the plane is tilted less.
 *
 * @returns `true` on a compact screen (narrow or short), and follows the viewport while it changes.
 */
export function useCompactTilt(): boolean {
  const [compact, setCompact] = useState(() => mediaMatches(COMPACT_QUERY));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(COMPACT_QUERY);
    const onChange = (): void => {
      setCompact(query.matches);
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);
  return compact;
}
