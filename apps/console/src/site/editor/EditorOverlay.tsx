/**
 * Interactive layer of the editor, drawn over the plan in site coordinates: the tool places features on a click,
 * draws a no-go zone by dragging, moves a selected feature by dragging or with the arrow keys, and resizes a selected
 * workstation or no-go zone by dragging one of its handles or with Alt+Shift+Arrow.
 *
 * Every feature is also a focusable control with a name and its position, so the keyboard reaches all of them.
 * The pointer is a shortcut; the feature panel is the complete keyboard path (see `FeaturePanel`).
 */
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dispatch } from "react";
import type { EditorFeatures, Rect, Size } from "../dxf/build-site-map";
import type { Point } from "../dxf/types";
import type { ViewBox } from "../svg-paths";
import { clientToMetres, snap } from "./coords";
import type { FeatureRef } from "./draft";
import { hitRect, hitSquareAt, minTargetM } from "./hit-targets";
import { ResizeHandles } from "./ResizeHandles";
import { handlePoint, workstationRect, type Handle } from "./shapes";
import { usePxPerMetre } from "./use-px-per-metre";
import { classNames } from "../../lib/class-names";
import type { ShapeRef, Tool, WizardAction } from "./wizard-reducer";
import { normaliseRect } from "./wizard-reducer";
import styles from "./Editor.module.css";

/** Keyboard step of a feature, in metres, and the step with Shift. */
const KEY_STEP_M = 0.1;
const KEY_STEP_SHIFT_M = 1;

/** Keyboard resize step, in metres: one grid step per key press, with Alt and Shift held. */
const KEY_RESIZE_STEP_M = 0.1;

/** Arrow keys and the direction each one resizes a shape in: a width and a height change, in grid steps. */
const RESIZE_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** The keyboard shortcuts of a resize, announced on the focusable shapes. */
const RESIZE_SHORTCUTS =
  "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown";

/** A pointer gesture in progress. */
type Gesture =
  | { readonly kind: "draw"; readonly start: Point }
  | { readonly kind: "move"; readonly target: FeatureRef; readonly last: Point }
  | {
      readonly kind: "resize";
      readonly target: ShapeRef;
      readonly handle: Handle;
      /** Pointer position minus the handle position when the drag started, so the handle does not jump. */
      readonly grab: Point;
      /** The footprint before the drag, restored when the drag is cancelled. */
      readonly startRect: Rect;
    };

/** A resizable shape that is selected, with its current footprint. */
interface SelectedShape {
  readonly target: ShapeRef;
  readonly rect: Rect;
}

/** Props of {@link EditorOverlay}. */
export interface EditorOverlayProps {
  /** The features placed so far. */
  readonly editor: EditorFeatures;
  /** The view box of the plan, used to convert the pointer. */
  readonly view: ViewBox;
  /** One marker unit in metres, which sizes the hit areas. */
  readonly unit: number;
  /** The current tool. */
  readonly tool: Tool;
  /** The selected feature, if any. */
  readonly selection: FeatureRef | null;
  /** Sends the changes to the wizard. */
  readonly dispatch: Dispatch<WizardAction>;
}

/**
 * Tells whether two references point to the same feature. The charger is unique, so only its kind matters.
 *
 * @param a - A reference.
 * @param b - Another reference.
 * @returns `true` for the same feature.
 */
function sameFeature(a: FeatureRef, b: FeatureRef): boolean {
  if (a.kind === "charger" || b.kind === "charger") {
    return a.kind === b.kind;
  }
  return a.kind === b.kind && a.index === b.index;
}

/**
 * The SVG geometry attributes of a rectangle, from the site rectangle with its `w` and `h`.
 *
 * @param rect - The rectangle, in site metres.
 * @returns The `x`, `y`, `width` and `height` attributes.
 */
function rectAttributes(rect: Rect): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
}

/**
 * Sets the pointer capture when the browser supports it, so that a drag keeps reporting after the pointer leaves
 * the element. Some environments do not implement it, and a drag then still works within the element.
 *
 * @param element - The element that receives the pointer.
 * @param pointerId - The pointer.
 */
function capturePointer(element: SVGElement, pointerId: number): void {
  if (typeof element.setPointerCapture === "function") {
    element.setPointerCapture(pointerId);
  }
}

/**
 * Reads a pointer position in site metres, without snapping it to the grid.
 *
 * @param event - The pointer event of an element of the plan.
 * @param view - The view box of the plan.
 * @returns The position, or `null` when the plan has no size to measure.
 */
function rawPointOf(event: React.PointerEvent<SVGElement>, view: ViewBox): Point | null {
  const svg = event.currentTarget.ownerSVGElement;
  if (svg === null) {
    return null;
  }
  return clientToMetres(svg, event.clientX, event.clientY, view);
}

/**
 * Reads a pointer position as a snapped point in site metres.
 *
 * @param event - The pointer event of an element of the plan.
 * @param view - The view box of the plan.
 * @returns The snapped point, or `null` when the plan has no size to measure.
 */
function pointOf(event: React.PointerEvent<SVGElement>, view: ViewBox): Point | null {
  const point = rawPointOf(event, view);
  return point === null ? null : snap(point);
}

/**
 * The selected feature, when it is a shape that can be resized, with its current footprint. A charger is a point
 * marker and is not resizable.
 *
 * @param editor - The features placed so far.
 * @param selection - The selected feature, if any.
 * @returns The shape, or `null` when nothing resizable is selected.
 */
function selectedShape(editor: EditorFeatures, selection: FeatureRef | null): SelectedShape | null {
  if (selection === null || selection.kind === "charger") {
    return null;
  }
  if (selection.kind === "workstation") {
    const workstation = editor.workstations[selection.index];
    return workstation === undefined
      ? null
      : { target: selection, rect: workstationRect(workstation) };
  }
  const rect = editor.nogo[selection.index];
  return rect === undefined ? null : { target: selection, rect };
}

/**
 * Renders the editor's interactive layer. It must be a child of the plan, so its coordinates are site metres.
 *
 * @param props - The features, the view, the tool, the selection and the dispatcher.
 * @returns The layer.
 */
export function EditorOverlay({
  editor,
  view,
  unit,
  tool,
  selection,
  dispatch,
}: EditorOverlayProps): React.JSX.Element {
  const { t, i18n } = useTranslation("site");
  const gesture = useRef<Gesture | null>(null);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  // True while a handle is dragged; it arms the Escape listener, which cancels the drag.
  const [resizing, setResizing] = useState(false);
  const backgroundRef = useRef<SVGRectElement>(null);
  // Pointer targets keep a minimum size on the screen, so the smallest side is measured in metres from the zoom.
  const pxPerM = usePxPerMetre(backgroundRef, view);
  const minSideM = minTargetM(pxPerM);

  /**
   * Starts an action on the empty plan: a placement, a no-go drag, or the end of the selection.
   *
   * @param event - The pointer down on the background.
   */
  const onBackgroundDown = (event: React.PointerEvent<SVGElement>): void => {
    const point = pointOf(event, view);
    if (point === null) {
      return;
    }
    switch (tool) {
      case "charger":
        dispatch({ type: "placeCharger", at: point });
        return;
      case "workstation":
        dispatch({ type: "addWorkstation", at: point });
        return;
      case "nogo":
        capturePointer(event.currentTarget, event.pointerId);
        gesture.current = { kind: "draw", start: point };
        setDrawing({ x: point[0], y: point[1], w: 0, h: 0 });
        return;
      case "select":
        dispatch({ type: "select", target: null });
        return;
    }
  };

  /**
   * Stretches the no-go zone being drawn to the pointer.
   *
   * @param event - The pointer move on the background.
   */
  const onBackgroundMove = (event: React.PointerEvent<SVGElement>): void => {
    const current = gesture.current;
    const point = pointOf(event, view);
    if (current?.kind !== "draw" || point === null) {
      return;
    }
    setDrawing({
      x: current.start[0],
      y: current.start[1],
      w: point[0] - current.start[0],
      h: point[1] - current.start[1],
    });
  };

  /**
   * Ends a no-go drag: the zone is kept when it has an area, and a click without a drag adds nothing.
   *
   * @param event - The pointer up on the background.
   */
  const onBackgroundUp = (event: React.PointerEvent<SVGElement>): void => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.kind !== "draw") {
      return;
    }
    const point = pointOf(event, view) ?? current.start;
    dispatch({
      type: "addNogo",
      rect: normaliseRect({
        x: current.start[0],
        y: current.start[1],
        w: point[0] - current.start[0],
        h: point[1] - current.start[1],
      }),
    });
    setDrawing(null);
  };

  /**
   * Selects a feature and starts moving it with the pointer.
   *
   * @param event - The pointer down on a feature.
   * @param target - The feature.
   */
  const onFeatureDown = (event: React.PointerEvent<SVGElement>, target: FeatureRef): void => {
    // The plan underneath must not start a placement or a drag of its own.
    event.stopPropagation();
    dispatch({ type: "select", target });
    const point = pointOf(event, view);
    if (point === null) {
      return;
    }
    capturePointer(event.currentTarget, event.pointerId);
    gesture.current = { kind: "move", target, last: point };
  };

  /**
   * Moves the feature being dragged by the snapped distance the pointer has covered.
   *
   * @param event - The pointer move on a feature.
   */
  const onFeatureMove = (event: React.PointerEvent<SVGElement>): void => {
    const current = gesture.current;
    const point = pointOf(event, view);
    if (current?.kind !== "move" || point === null) {
      return;
    }
    const dx = point[0] - current.last[0];
    const dy = point[1] - current.last[1];
    if (dx !== 0 || dy !== 0) {
      dispatch({ type: "moveBy", target: current.target, dx, dy });
      gesture.current = { ...current, last: point };
    }
  };

  /**
   * Ends a feature drag.
   */
  const onFeatureUp = (): void => {
    gesture.current = null;
  };

  /**
   * Starts a resize from one of the handles of the selected shape. The selection does not change, and the pointer
   * offset from the handle is kept, so the handle does not jump to the pointer when the drag starts.
   *
   * @param event - The pointer down on the handle.
   * @param shape - The selected shape, with its footprint before the drag.
   * @param handle - The handle.
   */
  const onHandleDown = (
    event: React.PointerEvent<SVGElement>,
    shape: SelectedShape,
    handle: Handle,
  ): void => {
    const point = rawPointOf(event, view);
    if (point === null) {
      return;
    }
    const at = handlePoint(shape.rect, handle);
    capturePointer(event.currentTarget, event.pointerId);
    gesture.current = {
      kind: "resize",
      target: shape.target,
      handle,
      grab: [point[0] - at[0], point[1] - at[1]],
      startRect: shape.rect,
    };
    setResizing(true);
  };

  /**
   * Drags the handle to the snapped pointer position. The reducer applies the size and plan limits.
   *
   * @param event - The pointer move over the handle.
   */
  const onHandleMove = (event: React.PointerEvent<SVGElement>): void => {
    const current = gesture.current;
    const point = rawPointOf(event, view);
    if (current?.kind !== "resize" || point === null) {
      return;
    }
    const to = snap([point[0] - current.grab[0], point[1] - current.grab[1]]);
    dispatch({ type: "resizeTo", target: current.target, handle: current.handle, to });
  };

  /**
   * Ends a resize: the shape keeps the size the drag left it at.
   */
  const onHandleUp = (): void => {
    gesture.current = null;
    setResizing(false);
  };

  /**
   * Cancels a resize: the shape goes back, verbatim, to the footprint it had when the drag started. It does nothing
   * when no resize is in progress, so the release that ends a drag does not cancel it a second time.
   */
  const cancelResize = useCallback((): void => {
    const current = gesture.current;
    if (current?.kind !== "resize") {
      return;
    }
    gesture.current = null;
    setResizing(false);
    dispatch({ type: "restoreShape", target: current.target, rect: current.startRect });
  }, [dispatch]);

  // Escape cancels a drag from anywhere on the page, not only from the handle that is held. The listener is a
  // capture listener on the window, so it runs before the sheet's document listener, and it stops the event there:
  // Escape during a drag cancels the drag only and never closes the sheet. Outside a drag it is not listened to.
  useEffect(() => {
    if (!resizing) {
      return;
    }
    const options: AddEventListenerOptions = { capture: true };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelResize();
    };
    window.addEventListener("keydown", onKeyDown, options);
    return () => {
      window.removeEventListener("keydown", onKeyDown, options);
    };
  }, [resizing, cancelResize]);

  /**
   * Handles the keys of a focused feature. Alt+Shift+Arrow resizes a workstation or a no-go zone by a grid step, and
   * the plain arrows move it, with Shift for a metre. Delete removes it, and Enter and Space select it.
   *
   * @param event - The key event.
   * @param target - The feature.
   */
  const onFeatureKey = (event: React.KeyboardEvent<SVGElement>, target: FeatureRef): void => {
    const resize = RESIZE_DIRECTIONS[event.key];
    if (event.altKey && event.shiftKey && resize !== undefined) {
      // A charger is a point and has no size: the chord does nothing, and it must not move the charger either.
      if (target.kind !== "charger") {
        event.preventDefault();
        dispatch({
          type: "resizeBy",
          target,
          dw: resize[0] * KEY_RESIZE_STEP_M,
          dh: resize[1] * KEY_RESIZE_STEP_M,
        });
      }
      return;
    }
    const step = event.shiftKey ? KEY_STEP_SHIFT_M : KEY_STEP_M;
    const moves: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      dispatch({ type: "moveBy", target, dx: move[0], dy: move[1] });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "remove", target });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      dispatch({ type: "select", target });
    }
  };

  /**
   * Whether a feature is the selected one.
   *
   * @param target - The feature.
   * @returns `true` when it is selected.
   */
  const isSelected = (target: FeatureRef): boolean =>
    selection !== null && sameFeature(selection, target);

  /**
   * Props shared by every focusable feature.
   *
   * @param target - The feature.
   * @param name - Its accessible name.
   * @returns The props of the focusable element.
   */
  const controlProps = (target: FeatureRef, name: string) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-label": name,
    // Only a workstation or a no-go zone has a size to resize from the keyboard.
    "aria-keyshortcuts": target.kind === "charger" ? undefined : RESIZE_SHORTCUTS,
    // Selection is a state of an item in a set, so it is `aria-current`, as in the feature panel, not a toggle.
    "aria-current": isSelected(target) ? ("true" as const) : undefined,
    className: classNames(styles.hit, isSelected(target) && styles.hitSelected),
    onPointerDown: (event: React.PointerEvent<SVGElement>) => {
      onFeatureDown(event, target);
    },
    onPointerMove: onFeatureMove,
    onPointerUp: onFeatureUp,
    onKeyDown: (event: React.KeyboardEvent<SVGElement>) => {
      onFeatureKey(event, target);
    },
  });

  // The decimal separator follows the language; one decimal is the snap grid's precision.
  const numbers = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const formatPoint = (point: Point, label: string): string =>
    t("edit.item", { item: label, x: numbers.format(point[0]), y: numbers.format(point[1]) });
  const formatSized = (at: Point, size: Size, label: string): string =>
    t("edit.itemSized", {
      item: label,
      x: numbers.format(at[0]),
      y: numbers.format(at[1]),
      width: numbers.format(size.width),
      height: numbers.format(size.height),
    });

  // The plan is flipped: the background spans the view, which is `-y` in site coordinates.
  const background = {
    x: view.minX,
    y: -(view.minY + view.height),
    width: view.width,
    height: view.height,
  };

  /**
   * The visible outline of a feature, at its real size. It is drawn after the pointer target, never receives events,
   * and shows the focus ring and the selection, so the inflated target stays invisible.
   *
   * @param target - The feature.
   * @param shape - The real shape, in site metres.
   * @returns The outline element.
   */
  const outline = (target: FeatureRef, shape: Rect): React.JSX.Element => (
    <rect
      {...rectAttributes(shape)}
      aria-hidden="true"
      className={classNames(styles.outline, isSelected(target) && styles.selected)}
    />
  );

  const shaped = tool === "select" ? selectedShape(editor, selection) : null;

  return (
    <g>
      <rect
        ref={backgroundRef}
        {...background}
        fill="transparent"
        className={styles.background}
        onPointerDown={onBackgroundDown}
        onPointerMove={onBackgroundMove}
        onPointerUp={onBackgroundUp}
      />
      {editor.nogo.map((rect, index) => {
        const target: FeatureRef = { kind: "nogo", index };
        return (
          <g key={`nogo-${String(index)}`}>
            <rect
              {...rectAttributes(hitRect(rect, minSideM))}
              {...controlProps(
                target,
                formatSized(
                  [rect.x, rect.y],
                  { width: rect.w, height: rect.h },
                  t("edit.panel.nogo", { number: index + 1 }),
                ),
              )}
            />
            {outline(target, rect)}
          </g>
        );
      })}
      {editor.workstations.map((workstation, index) => {
        const target: FeatureRef = { kind: "workstation", index };
        // The footprint is the real shape; the pointer target is inflated around it to the minimum size.
        const shape = workstationRect(workstation);
        return (
          <g key={`station-${String(index)}`}>
            <rect
              {...rectAttributes(hitRect(shape, minSideM))}
              {...controlProps(
                target,
                formatSized(
                  workstation.at,
                  workstation.size,
                  `${t("edit.panel.workstation", { number: index + 1 })} ${workstation.name}`,
                ),
              )}
            />
            {outline(target, shape)}
          </g>
        );
      })}
      {editor.charger === null ? null : (
        <g>
          <rect
            {...rectAttributes(hitSquareAt(editor.charger, minSideM))}
            {...controlProps(
              { kind: "charger" },
              formatPoint(editor.charger, t("edit.panel.charger")),
            )}
          />
          {/* The bolt is drawn in a box of two marker units, centred on the charger. */}
          {outline(
            { kind: "charger" },
            {
              x: editor.charger[0] - unit,
              y: editor.charger[1] - unit,
              w: 2 * unit,
              h: 2 * unit,
            },
          )}
        </g>
      )}
      {drawing === null ? null : (
        <rect
          x={Math.min(drawing.x, drawing.x + drawing.w)}
          y={Math.min(drawing.y, drawing.y + drawing.h)}
          width={Math.abs(drawing.w)}
          height={Math.abs(drawing.h)}
          className={styles.drawing}
          aria-hidden="true"
        />
      )}
      {shaped === null ? null : (
        <ResizeHandles
          rect={shaped.rect}
          pxPerMetre={pxPerM}
          onResizeStart={(handle, event) => {
            onHandleDown(event, shaped, handle);
          }}
          onResizeMove={onHandleMove}
          onResizeEnd={onHandleUp}
          onResizeCancel={cancelResize}
        />
      )}
    </g>
  );
}
