/**
 * The fleet map of the console: the active site plan on a tilted plane, the robots on top of it, and the controls.
 *
 * The plane is rotated with the viewport tilt (flat, tilted or compact). The plan is fitted in the plane and zoomed
 * and panned by the view state; the markers are projected with the same geometry, so they stay on their place.
 *
 * Without a plan (loading, no active site map, or a failed download) the decorative plane is shown, with a notice
 * when the download failed. Gestures: wheel and pinch zoom, drag pans. Keys: `+` and `-` zoom, arrow keys pan, from
 * anywhere inside the map. The stage itself is not a tab stop, so the shell keeps its keyboard order; keyboard users
 * reach the map through the controls and the robot markers.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/http-client";
import { useSiteMap } from "../../site/use-site-map";
import { featureLayers, mapViewBox } from "../../site/render/map-geometry";
import { SiteMapView } from "../../site/render/SiteMapView";
import { useFleetStore } from "../../live/fleet-store";
import { useSelectionStore } from "../../live/selection-store";
import { map, motion, space } from "../../theme/tokens";
import { MapControls } from "./MapControls";
import { MarkerLayer } from "./MarkerLayer";
import { PlaceholderDrawing } from "./PlaceholderPlane";
import { useCompactTilt, usePlaneGeometry } from "./geometry-hooks";
import { centreOn, fitContent, interpolateView, unprojectToPlane, type Point2 } from "./projection";
import { INITIAL_MAP_VIEW, mapViewReducer } from "./view-reducer";
import styles from "./FleetMap.module.css";

/** Distance one arrow key press pans the map, in pixels. */
const PAN_STEP_PX = space[7];

/**
 * Tells whether the user asked for less motion. Returns `false` where `matchMedia` does not exist.
 *
 * @returns `true` when reduced motion is requested.
 */
function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Distance between two points.
 *
 * @param a - First point.
 * @param b - Second point.
 * @returns The distance, in pixels.
 */
function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Renders the fleet map.
 *
 * @returns The map stage: the plane or the plan, the robot markers, the controls and any notice.
 */
export function FleetMap(): React.JSX.Element {
  const { t } = useTranslation("fleet");
  const query = useSiteMap("active", true);
  const layers = useMemo(
    () => (query.data === undefined ? null : featureLayers(query.data)),
    [query.data],
  );
  const viewBox = useMemo(() => (layers === null ? null : mapViewBox(layers)), [layers]);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(mapViewReducer, INITIAL_MAP_VIEW);
  const compact = useCompactTilt();
  const tiltDeg = state.flat ? 0 : compact ? map.tiltCompactDeg : map.tiltDeg;
  const plane = usePlaneGeometry(stageRef, planeRef, tiltDeg);
  const frame = useMemo(
    () =>
      viewBox === null || plane === null
        ? null
        : fitContent(viewBox, plane.planeWidth, plane.planeHeight),
    [viewBox, plane],
  );
  const pointers = useRef(new Map<number, Point2>());
  const latest = useRef({ view: state.view, frame, plane });
  const focus = useSelectionStore((selection) => selection.focus);

  // Read by the focus animation, which runs outside React's render. Updated after each commit.
  useLayoutEffect(() => {
    latest.current = { view: state.view, frame, plane };
  });

  // A focus request centres the robot. The move eases over the fly-to duration, or jumps for reduced motion.
  useEffect(() => {
    if (focus === null) {
      return;
    }
    const { view, frame: content, plane: geometry } = latest.current;
    const robot = Object.values(useFleetStore.getState().robots).find(
      (candidate) => candidate.robotId === focus.robotId,
    );
    const pose = robot?.pose ?? null;
    if (pose === null || content === null || geometry === null) {
      return;
    }
    const target = centreOn(view, { x: pose.x, y: pose.y }, content);
    if (prefersReducedMotion()) {
      dispatch({ type: "setView", view: target });
      return;
    }
    const startAt = performance.now();
    let frameId = 0;
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startAt) / motion.flyToMs);
      // Ease out: fast at the start, settling on the target.
      const eased = 1 - (1 - progress) ** 3;
      dispatch({ type: "setView", view: interpolateView(view, target, eased) });
      if (progress < 1) {
        frameId = requestAnimationFrame(step);
      }
    };
    frameId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [focus]);

  // The wheel must be non-passive so that the page does not scroll while the map zooms.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || frame === null || plane === null) {
      return;
    }
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const anchor = unprojectToPlane(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        plane,
      );
      dispatch({
        type: "zoomAt",
        factor: Math.exp(-event.deltaY * map.wheelZoomPerPixel),
        anchor,
        frame,
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
    };
  }, [frame, plane]);

  /**
   * Position of a pointer, in stage pixels.
   *
   * @param event - The pointer event.
   * @returns The position.
   */
  const stagePoint = (event: PointerEvent<HTMLDivElement>): Point2 => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Markers and controls keep their own clicks; only the plane starts a drag or a pinch.
    if (event.target instanceof Element && event.target.closest("button") !== null) {
      return;
    }
    pointers.current.set(event.pointerId, stagePoint(event));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined || frame === null || plane === null) {
      return;
    }
    const next = stagePoint(event);
    pointers.current.set(event.pointerId, next);
    const other = [...pointers.current.entries()]
      .filter(([id]) => id !== event.pointerId)
      .map(([, point]) => point)[0];
    if (other === undefined) {
      dispatch({ type: "panBy", dx: next.x - previous.x, dy: next.y - previous.y, plane });
      return;
    }
    // Two pointers: zoom by the change of their distance, about their midpoint.
    const before = distance(previous, other);
    const after = distance(next, other);
    if (before === 0 || after === 0) {
      return;
    }
    const midpoint = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
    dispatch({
      type: "zoomAt",
      factor: after / before,
      anchor: unprojectToPlane(midpoint, plane),
      frame,
    });
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A marker handles its arrow keys (roving focus) and marks the event; the map pans and zooms with the rest.
    if (event.defaultPrevented || frame === null || plane === null) {
      return;
    }
    switch (event.key) {
      case "+":
      case "=":
        dispatch({ type: "zoomIn", frame });
        break;
      case "-":
        dispatch({ type: "zoomOut", frame });
        break;
      case "ArrowLeft":
        dispatch({ type: "panBy", dx: PAN_STEP_PX, dy: 0, plane });
        break;
      case "ArrowRight":
        dispatch({ type: "panBy", dx: -PAN_STEP_PX, dy: 0, plane });
        break;
      case "ArrowUp":
        dispatch({ type: "panBy", dx: 0, dy: PAN_STEP_PX, plane });
        break;
      case "ArrowDown":
        dispatch({ type: "panBy", dx: 0, dy: -PAN_STEP_PX, plane });
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const notice = query.isError
    ? query.error instanceof ApiError && query.error.status === 404
      ? { message: t("map.none"), retry: false }
      : { message: t("map.unavailable"), retry: true }
    : null;

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      role="group"
      aria-label={t("map.label")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        ref={planeRef}
        className={styles.plane}
        style={{ transform: `rotateX(${String(tiltDeg)}deg)` }}
      >
        {layers !== null && frame !== null ? (
          <div
            className={styles.content}
            style={{
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
              transform: `translate(${String(state.view.panX)}px, ${String(state.view.panY)}px) scale(${String(state.view.zoom)})`,
            }}
          >
            <SiteMapView layers={layers} label={t("map.label")} />
          </div>
        ) : (
          <PlaceholderDrawing />
        )}
      </div>
      {frame !== null && plane !== null ? (
        <MarkerLayer frame={frame} view={state.view} plane={plane} />
      ) : null}
      {frame === null ? null : (
        <MapControls
          flat={state.flat}
          onZoomIn={() => {
            dispatch({ type: "zoomIn", frame });
          }}
          onZoomOut={() => {
            dispatch({ type: "zoomOut", frame });
          }}
          onReset={() => {
            dispatch({ type: "reset" });
          }}
          onToggleFlat={() => {
            dispatch({ type: "toggleFlat" });
          }}
        />
      )}
      {notice === null ? null : (
        <div role="status" className={styles.notice}>
          <p>{notice.message}</p>
          {notice.retry ? (
            <button
              type="button"
              className={styles.retry}
              onClick={() => {
                void query.refetch();
              }}
            >
              {t("map.retry")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
