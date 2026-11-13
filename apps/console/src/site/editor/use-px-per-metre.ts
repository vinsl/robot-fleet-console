/**
 * Measures the screen size of the plan, so that the editor's pointer targets keep a minimum size on the screen
 * whatever the zoom and the window width.
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import type { ViewBox } from "../svg-paths";
import { pxPerMetre } from "./hit-targets";

/**
 * Tracks the number of screen pixels per site metre of the plan that holds the element.
 *
 * The plan is drawn at `width: 100%` with a fixed aspect ratio, so its width in pixels divided by the width of its
 * view box is the scale. The width is read on mount and whenever the element is resized. Without a layout (a test
 * environment, or a browser without `ResizeObserver`) the fallback scale applies.
 *
 * @param ref - A ref to any element of the plan; its owning SVG is measured.
 * @param view - The view box of the plan, in site metres.
 * @returns The screen pixels per site metre.
 */
export function usePxPerMetre(ref: React.RefObject<SVGElement | null>, view: ViewBox): number {
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    const svg = ref.current?.ownerSVGElement;
    if (svg === null || svg === undefined) {
      return;
    }
    const measure = (): void => {
      setWidthPx(svg.getBoundingClientRect().width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return pxPerMetre(widthPx, view.width);
}
