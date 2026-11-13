/**
 * Resize handles of the selected workstation footprint or no-go zone: up to eight squares on its outline. Each handle
 * is a small visible square with a ring and a larger transparent square that receives the pointer.
 *
 * The handles are a pointer shortcut only. They are hidden from assistive technology and are not tab stops: the
 * keyboard resizes with Alt+Shift+Arrow and the feature panel gives exact values (see `EditorOverlay`).
 */
import type * as React from "react";
import type { Rect } from "../dxf/build-site-map";
import { classNames } from "../../lib/class-names";
import { handleHitPx, handlePoint, visibleHandles, type Handle } from "./shapes";
import styles from "./Editor.module.css";

/**
 * Side of the visible handle square, in CSS pixels. The pointer target around it is larger; see `handleHitPx`.
 */
export const HANDLE_VISIBLE_PX = 10;

/**
 * The cursor that tells the operator which way a handle moves its edges.
 *
 * @param handle - The handle.
 * @returns The CSS class of the cursor, or `undefined` when the module does not define it.
 */
function cursorClass(handle: Handle): string | undefined {
  switch (handle) {
    case "nw":
    case "se":
      return styles.cursorNwse;
    case "ne":
    case "sw":
      return styles.cursorNesw;
    case "e":
    case "w":
      return styles.cursorEw;
    case "n":
    case "s":
      return styles.cursorNs;
  }
}

/** Props of {@link ResizeHandles}. */
export interface ResizeHandlesProps {
  /** The shape being resized, in site metres. */
  readonly rect: Rect;
  /** Screen pixels per site metre, which sizes the handles in metres. */
  readonly pxPerMetre: number;
  /** Called when the pointer goes down on a handle. */
  readonly onResizeStart: (handle: Handle, event: React.PointerEvent<SVGElement>) => void;
  /** Called while the pointer moves over a handle that is being dragged. */
  readonly onResizeMove: (event: React.PointerEvent<SVGElement>) => void;
  /** Called when the pointer is released on a handle. */
  readonly onResizeEnd: (event: React.PointerEvent<SVGElement>) => void;
  /** Called when the drag is interrupted by the browser rather than released. */
  readonly onResizeCancel: () => void;
}

/**
 * Renders the handles of a shape. The handles are drawn after every other feature, so they are on top of the
 * pointer targets of the shape they resize.
 *
 * @param props - The shape, the scale and the pointer callbacks.
 * @returns The handles.
 */
export function ResizeHandles({
  rect,
  pxPerMetre,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeCancel,
}: ResizeHandlesProps): React.JSX.Element {
  // Both sizes are in metres, so the handles keep the same size on the screen at any zoom.
  const visibleM = HANDLE_VISIBLE_PX / pxPerMetre;
  const hitM = handleHitPx(rect, pxPerMetre) / pxPerMetre;
  return (
    <g aria-hidden="true">
      {visibleHandles(rect, pxPerMetre).map((handle) => {
        const [cx, cy] = handlePoint(rect, handle);
        return (
          <g key={handle} data-handle={handle}>
            <rect
              x={cx - visibleM / 2}
              y={cy - visibleM / 2}
              width={visibleM}
              height={visibleM}
              className={styles.handle}
            />
            <rect
              x={cx - hitM / 2}
              y={cy - hitM / 2}
              width={hitM}
              height={hitM}
              className={classNames(styles.handleHit, cursorClass(handle))}
              onPointerDown={(event) => {
                onResizeStart(handle, event);
              }}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeCancel}
              onLostPointerCapture={onResizeCancel}
            />
          </g>
        );
      })}
    </g>
  );
}
