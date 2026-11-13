/**
 * @vitest-environment jsdom
 *
 * The resize handles of a shape: how many are drawn for its size, how large the visible square and the pointer target
 * are on the screen, and which callback each pointer event reaches.
 */
import type * as React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Rect } from "../../../src/site/dxf/build-site-map";
import { HANDLE_VISIBLE_PX, ResizeHandles } from "../../../src/site/editor/ResizeHandles";
import { HANDLE_HIT_PX, HANDLE_MIN_HIT_PX, type Handle } from "../../../src/site/editor/shapes";

/** Screen pixels per metre used by every test, so the expected sizes are whole numbers. */
const PX_PER_M = 40;

afterEach(() => {
  cleanup();
});

/**
 * Renders the handles of a shape inside an SVG, with spies for each callback.
 *
 * @param rect - The shape.
 * @returns The rendered container and the callback spies.
 */
function renderHandles(rect: Rect) {
  const onResizeStart = vi.fn<(handle: Handle, event: React.PointerEvent<SVGElement>) => void>();
  const onResizeMove = vi.fn<(event: React.PointerEvent<SVGElement>) => void>();
  const onResizeEnd = vi.fn<(event: React.PointerEvent<SVGElement>) => void>();
  const onResizeCancel = vi.fn<() => void>();
  const view = render(
    <svg>
      <ResizeHandles
        rect={rect}
        pxPerMetre={PX_PER_M}
        onResizeStart={onResizeStart}
        onResizeMove={onResizeMove}
        onResizeEnd={onResizeEnd}
        onResizeCancel={onResizeCancel}
      />
    </svg>,
  );
  return { view, onResizeStart, onResizeMove, onResizeEnd, onResizeCancel };
}

/**
 * The handles drawn, in order, by their names.
 *
 * @returns The handle names.
 */
function drawnHandles(): string[] {
  return Array.from(document.querySelectorAll("g[data-handle]")).map(
    (group) => group.getAttribute("data-handle") ?? "",
  );
}

/**
 * The visible square and the pointer target of one handle.
 *
 * @param name - The handle name.
 * @returns The two rectangles; the target is the second one.
 */
function handleRects(name: string): readonly SVGRectElement[] {
  const group = document.querySelector(`g[data-handle="${name}"]`);
  return Array.from(group?.querySelectorAll("rect") ?? []);
}

/**
 * The on-screen width of an SVG rectangle, in pixels, for the test scale.
 *
 * @param element - The rectangle.
 * @returns The width in pixels.
 */
function widthPx(element: SVGRectElement | undefined): number {
  return Number(element?.getAttribute("width")) * PX_PER_M;
}

describe("ResizeHandles", () => {
  it("draws eight handles on a shape that is large enough on the screen", () => {
    renderHandles({ x: 1, y: 1, w: 4, h: 2 });

    expect(drawnHandles()).toEqual(["n", "ne", "e", "se", "s", "sw", "w", "nw"]);
  });

  it("draws a visible square of 10 px inside a pointer target of 24 px, and hides both from assistive technology", () => {
    renderHandles({ x: 1, y: 1, w: 4, h: 2 });
    const [visible, target] = handleRects("se");

    expect(widthPx(visible)).toBe(HANDLE_VISIBLE_PX);
    expect(widthPx(target)).toBe(HANDLE_HIT_PX);
    expect(document.querySelector("g[aria-hidden='true']")).not.toBeNull();
  });

  it("hides the edge handles of an axis whose side is too short on the screen", () => {
    // Both sides are 20 px on the screen: only the four corners remain.
    renderHandles({ x: 1, y: 1, w: 0.5, h: 0.5 });

    expect(drawnHandles()).toEqual(["ne", "se", "sw", "nw"]);
  });

  it("hides only the handles of the short axis", () => {
    // 160 px wide but 20 px high: the north and south handles go, the east and west ones stay.
    renderHandles({ x: 1, y: 1, w: 4, h: 0.5 });

    expect(drawnHandles()).toEqual(["ne", "e", "se", "sw", "w", "nw"]);
  });

  it("shrinks the pointer target of a small shape, but keeps it at least 12 px", () => {
    renderHandles({ x: 1, y: 1, w: 0.5, h: 0.5 });

    expect(widthPx(handleRects("ne")[1])).toBe(HANDLE_MIN_HIT_PX);
  });

  it("reports the handle that is pressed, and the moves and the end of the drag", () => {
    const { onResizeStart, onResizeMove, onResizeEnd } = renderHandles({
      x: 1,
      y: 1,
      w: 4,
      h: 2,
    });
    const target = handleRects("e")[1];
    if (target === undefined) throw new Error("no target for the east handle");

    fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 0, clientY: 0 });

    expect(onResizeStart).toHaveBeenCalledWith("e", expect.anything());
    expect(onResizeMove).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it("cancels the drag when the browser takes the pointer capture away", () => {
    const { onResizeCancel } = renderHandles({ x: 1, y: 1, w: 4, h: 2 });
    const target = handleRects("n")[1];
    if (target === undefined) throw new Error("no target for the north handle");

    fireEvent(target, new Event("lostpointercapture", { bubbles: true }));

    expect(onResizeCancel).toHaveBeenCalledTimes(1);
  });
});
