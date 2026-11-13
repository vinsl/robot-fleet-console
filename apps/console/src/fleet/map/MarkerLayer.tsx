/**
 * The robots on the fleet map: one button per positioned robot that passes the filter, placed by a single animation
 * loop, with roving keyboard focus between them.
 *
 * Placement never goes through React state. The loop reads the newest pose of each robot from the store, draws it
 * between samples (`poseAt`), and writes the transform and the heading of its button. React renders the buttons
 * only when the set of robots, the filter, the connection or the clock changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMatch, useNavigate } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { useActiveAlerts } from "../../api/alerts";
import { formatDuration } from "../../lib/duration";
import { formatBattery } from "../../lib/format-battery";
import { useFleetStore } from "../../live/fleet-store";
import { poseAt, type LiveRobot } from "../../live/fleet-reducer";
import { matchesFilter, useFleetFilterStore } from "../../live/fleet-filter-store";
import { robotView, type RobotView } from "../../live/fleet-selectors";
import { useNow } from "../../live/use-now";
import { STATE_VISUALS } from "../../theme/robot-state-visuals";
import { map, tokens } from "../../theme/tokens";
import { useWsStore } from "../../ws/ws-store";
import type { RobotPose } from "@mfc/protocol";
import { StateMarker } from "./StateMarker";
import {
  screenHeading,
  siteToScreen,
  type ContentFrame,
  type PlaneGeometry,
  type Point2,
  type ViewTransform,
} from "./projection";
import styles from "./MarkerLayer.module.css";

/** Direction of a keyboard move between markers. */
export type Direction = "up" | "down" | "left" | "right";

/**
 * Weight of the sideways offset in {@link nearestInDirection}. A marker straight ahead wins over one that is a little
 * closer but far to the side.
 */
const CROSS_WEIGHT = 2;

/**
 * Lucide's `Navigation2` icon points up. The screen angle of "up" is `-pi / 2`, so the icon turns by 90 degrees more.
 */
const NAVIGATION_ICON_UP_DEG = 90;

/** Radians to degrees. */
const RAD_TO_DEG = 180 / Math.PI;

/** Props of {@link MarkerLayer}: the placement of the map that the markers are drawn on. */
export interface MarkerLayerProps {
  readonly frame: ContentFrame;
  readonly view: ViewTransform;
  readonly plane: PlaneGeometry;
}

/**
 * Finds the marker to focus when an arrow key is pressed. Among the markers on the requested side, the closest one
 * wins, where the distance counts the sideways offset twice.
 *
 * @param points - Screen position of every marker, by robot identifier.
 * @param fromId - The marker that has the focus.
 * @param direction - The arrow direction.
 * @returns The identifier of the marker to focus, or `null` when none lies in that direction.
 */
export function nearestInDirection(
  points: ReadonlyMap<string, Point2>,
  fromId: string,
  direction: Direction,
): string | null {
  const from = points.get(fromId);
  if (from === undefined) {
    return null;
  }
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [id, point] of points) {
    if (id === fromId) {
      continue;
    }
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const main = mainAxis(direction, dx, dy);
    if (main <= 0) {
      continue;
    }
    const cross = Math.abs(direction === "up" || direction === "down" ? dx : dy);
    const score = main + CROSS_WEIGHT * cross;
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Projects a displacement on the axis of a direction. Positive means "in that direction".
 *
 * @param direction - The direction.
 * @param dx - Horizontal displacement, in screen pixels (x grows to the right).
 * @param dy - Vertical displacement, in screen pixels (y grows downwards).
 * @returns The displacement along the direction.
 */
function mainAxis(direction: Direction, dx: number, dy: number): number {
  switch (direction) {
    case "up":
      return -dy;
    case "down":
      return dy;
    case "left":
      return -dx;
    case "right":
      return dx;
  }
}

/**
 * Maps an arrow key to a direction.
 *
 * @param key - The `key` of a keyboard event.
 * @returns The direction, or `null` for any other key.
 */
function directionOf(key: string): Direction | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

/**
 * The pose to draw for a robot at a given time: the interpolation while it runs, else the newest sample.
 *
 * @param robot - The robot.
 * @param at - Client time in milliseconds.
 * @returns The pose, or `null` when the robot has never been positioned.
 */
function currentPose(robot: LiveRobot, at: number): RobotPose | null {
  if (robot.motion !== null) {
    return poseAt(robot.motion, at);
  }
  return robot.pose;
}

/**
 * Chooses the marker that takes part in the tab order: the focused one, else the open robot, else the first.
 *
 * @param shown - The markers on the map, in order.
 * @param roving - The marker that last had the focus, if any.
 * @param selected - The robot open in the side panel, if any.
 * @returns The identifier of the tab stop, or `null` when no marker is shown.
 */
function tabStopOf(
  shown: readonly RobotView[],
  roving: string | null,
  selected: string | null,
): string | null {
  const ids = shown.map((view) => view.robot.robotId);
  if (roving !== null && ids.includes(roving)) {
    return roving;
  }
  if (selected !== null && ids.includes(selected)) {
    return selected;
  }
  return ids[0] ?? null;
}

/**
 * Renders the robot markers of the fleet map and drives their placement.
 *
 * @param props - The content frame, the view and the plane geometry the markers are projected with.
 * @returns The marker group and a hidden count of the robots that the filter hides.
 */
export function MarkerLayer({ frame, view, plane }: MarkerLayerProps): React.JSX.Element {
  const { t, i18n } = useTranslation("fleet");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  const robots = useFleetStore(useShallow((state) => state.robots));
  const connection = useWsStore((state) => state.connection);
  const now = useNow(tokens.live.nowTickMs);
  const filter = useFleetFilterStore((state) => state.filter);
  const alerts = useActiveAlerts();
  const match = useMatch("/robots/:robotId");
  const selectedId = match?.params.robotId ?? null;
  const [roving, setRoving] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const latest = useRef({ frame, view, plane });

  // The loop reads the latest geometry. Updated after each commit, before the next animation frame.
  useLayoutEffect(() => {
    latest.current = { frame, view, plane };
  });

  useEffect(() => {
    let frameId = 0;
    const tick = (): void => {
      const geometry = latest.current;
      const at = Date.now();
      for (const robot of Object.values(useFleetStore.getState().robots)) {
        const element = elements.current.get(robot.robotId);
        const pose = element === undefined ? null : currentPose(robot, at);
        if (element === undefined || pose === null) {
          continue;
        }
        const site = { x: pose.x, y: pose.y };
        const screen = siteToScreen(site, geometry.frame, geometry.view, geometry.plane);
        const heading = screenHeading(
          site,
          pose.heading,
          geometry.frame,
          geometry.view,
          geometry.plane,
        );
        element.style.transform = `translate3d(${String(screen.x)}px, ${String(screen.y)}px, 0) translate(-50%, -50%)`;
        element.style.setProperty(
          "--heading",
          `${String(heading * RAD_TO_DEG + NAVIGATION_ICON_UP_DEG)}deg`,
        );
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  const openAlertIds = useMemo(
    () => new Set((alerts.data ?? []).map((alert) => alert.robotId)),
    [alerts.data],
  );
  const connectionOpen = connection === "open";
  const views = Object.values(robots)
    .filter((robot) => robot.pose !== null)
    .sort((a, b) => a.robotId.localeCompare(b.robotId))
    .map((robot) => robotView(robot, now, connectionOpen));
  const shown = views.filter((candidate) => matchesFilter(candidate, filter, openAlertIds));
  const hidden = views.length - shown.length;
  const tabStop = tabStopOf(shown, roving, selectedId);
  // Markers drop their icon below this zoom; the shape, the fill and the heading stay.
  const detail = view.zoom >= map.markerDetailMinZoom;

  /**
   * Moves the focus to the marker in an arrow direction.
   *
   * @param event - The key event of the marker that has the focus.
   * @param id - Identifier of that marker.
   */
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const direction = directionOf(event.key);
    if (direction === null) {
      return;
    }
    event.preventDefault();
    const at = Date.now();
    const points = new Map<string, Point2>();
    for (const item of shown) {
      const pose = currentPose(item.robot, at);
      if (pose !== null) {
        points.set(item.robot.robotId, siteToScreen({ x: pose.x, y: pose.y }, frame, view, plane));
      }
    }
    const target = nearestInDirection(points, id, direction);
    if (target !== null) {
      elements.current.get(target)?.focus();
      setRoving(target);
    }
  };

  return (
    <div className={styles.layer}>
      <div role="group" aria-label={t("map.robotsGroup")} className={styles.group}>
        {shown.map((item) => {
          const { robot } = item;

          const stateLabel = t(STATE_VISUALS[item.displayState].labelKey, { ns: "states" });
          const values = {
            robot: robot.robotId,
            state: stateLabel,
            battery: formatBattery(robot.battery, i18n.language),
          };
          const label = item.stale
            ? t("marker.labelStale", { ...values, age: formatDuration(item.ageMs, tCommon) })
            : t("marker.label", values);
          const selected = robot.robotId === selectedId;
          return (
            <button
              key={robot.robotId}
              type="button"
              ref={(element) => {
                if (element === null) {
                  elements.current.delete(robot.robotId);
                } else {
                  elements.current.set(robot.robotId, element);
                }
              }}
              className={styles.marker}
              tabIndex={robot.robotId === tabStop ? 0 : -1}
              aria-label={label}
              aria-current={selected ? "true" : undefined}
              onFocus={() => {
                setRoving(robot.robotId);
              }}
              onClick={() => {
                void navigate(`/robots/${robot.robotId}`);
              }}
              onKeyDown={(event) => {
                moveFocus(event, robot.robotId);
              }}
            >
              <StateMarker
                state={item.displayState}
                badges={item.badges}
                selected={selected}
                detail={detail}
                stale={item.stale}
              />
              <span className={styles.id}>{robot.robotId}</span>
            </button>
          );
        })}
      </div>
      {hidden > 0 ? (
        <p className="visually-hidden">{t("map.hiddenByFilter", { count: hidden })}</p>
      ) : null}
    </div>
  );
}
