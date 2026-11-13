/**
 * Reducer of the map viewport: zoom, pan, the focus on one robot, and the flat or tilted view.
 *
 * The actions carry the frame and the plane they apply to, because the reducer has no layout of its own. It is
 * pure, so every gesture (buttons, wheel, drag, pinch, keys) is tested without a DOM.
 */
import { map } from "../../theme/tokens";
import {
  IDENTITY_VIEW,
  centreOn,
  panBy,
  zoomAt,
  type ContentFrame,
  type PlaneGeometry,
  type Point2,
  type ViewTransform,
} from "./projection";

/** What the map shows: the viewport and whether the plane is flat. */
export interface MapViewState {
  readonly view: ViewTransform;
  /** `true` for the flat view (no tilt). */
  readonly flat: boolean;
}

/** The first state of the map: unzoomed, tilted. */
export const INITIAL_MAP_VIEW: MapViewState = { view: IDENTITY_VIEW, flat: false };

/** Every change the map can make to its viewport. */
export type MapViewAction =
  | { readonly type: "zoomIn"; readonly frame: ContentFrame }
  | { readonly type: "zoomOut"; readonly frame: ContentFrame }
  | { readonly type: "reset" }
  | {
      readonly type: "zoomAt";
      readonly factor: number;
      /** Plane point kept under the pointer, in plane pixels. */
      readonly anchor: Point2;
      readonly frame: ContentFrame;
    }
  | {
      readonly type: "panBy";
      readonly dx: number;
      readonly dy: number;
      readonly plane: PlaneGeometry;
    }
  | { readonly type: "centreOn"; readonly p: Point2; readonly frame: ContentFrame }
  /** Replaces the view, used by the animation of a focus request. */
  | { readonly type: "setView"; readonly view: ViewTransform }
  | { readonly type: "toggleFlat" };

/**
 * Applies one action to the map viewport.
 *
 * @param state - The current state.
 * @param action - The change to apply.
 * @returns The new state, or the same object when nothing changes.
 */
export function mapViewReducer(state: MapViewState, action: MapViewAction): MapViewState {
  switch (action.type) {
    case "zoomIn":
      return withView(state, zoomAround(state.view, map.zoomStep, action.frame));
    case "zoomOut":
      return withView(state, zoomAround(state.view, 1 / map.zoomStep, action.frame));
    case "reset":
      return withView(state, IDENTITY_VIEW);
    case "zoomAt":
      return withView(state, zoomAt(state.view, action.factor, action.anchor, action.frame));
    case "panBy":
      return withView(state, panBy(state.view, action.dx, action.dy, action.plane));
    case "centreOn":
      return withView(state, centreOn(state.view, action.p, action.frame));
    case "setView":
      return withView(state, action.view);
    case "toggleFlat":
      return { view: state.view, flat: !state.flat };
  }
}

/**
 * Zooms about the centre of the content, by a factor.
 *
 * @param view - The current view.
 * @param factor - Multiplicative change of the zoom.
 * @param frame - The content frame.
 * @returns The new view.
 */
function zoomAround(view: ViewTransform, factor: number, frame: ContentFrame): ViewTransform {
  const centre = { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
  return zoomAt(view, factor, centre, frame);
}

/**
 * Keeps the state object when the view did not change, so that React does not re-render for nothing.
 *
 * @param state - The current state.
 * @param view - The new view.
 * @returns The state with the new view, or the same state.
 */
function withView(state: MapViewState, view: ViewTransform): MapViewState {
  if (
    view.zoom === state.view.zoom &&
    view.panX === state.view.panX &&
    view.panY === state.view.panY
  ) {
    return state;
  }
  return { view, flat: state.flat };
}
