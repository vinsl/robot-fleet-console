/**
 * Derived views of the live robots: the state shown to the operator, the silence and stale rules, and the
 * badges. Every function takes `now` and whether the connection is open, so it is pure and testable.
 *
 * The silence rules depend on the connection (ADR 0057, D9): while the console is disconnected, no robot is
 * painted OFFLINE locally, because the disconnection is the real problem and the map shows it as stale.
 */
import { BATTERY_LOW_PERCENT, OFFLINE_SILENCE_MS, type RobotState } from "@mfc/protocol";
import { BADGE_ORDER, type BadgeKind } from "../theme/robot-state-visuals";
import { map } from "../theme/tokens";
import type { FleetData, LiveRobot } from "./fleet-reducer";

/** The state shown for a robot. Same vocabulary as the robot state. */
export type DisplayState = RobotState;

/** A robot with everything the views derive from it. */
export interface RobotView {
  readonly robot: LiveRobot;
  readonly displayState: DisplayState;
  /** Milliseconds since the last frame about the robot, never negative. */
  readonly ageMs: number;
  /** Whether the last frame is older than `map.staleAfterMs`. */
  readonly stale: boolean;
  /** Badges to draw, in {@link BADGE_ORDER}. */
  readonly badges: readonly BadgeKind[];
}

/**
 * Derives the view of one robot.
 *
 * While the connection is open, a robot silent for `OFFLINE_SILENCE_MS` (or reported OFFLINE) is shown
 * OFFLINE. While it is closed, only the cloud's own presence counts, and the age only makes the robot stale.
 *
 * @param robot - The robot.
 * @param now - Client time in milliseconds.
 * @param connectionOpen - Whether the realtime connection is open.
 * @returns The derived view.
 */
export function robotView(robot: LiveRobot, now: number, connectionOpen: boolean): RobotView {
  const ageMs = Math.max(0, now - robot.lastHeardAt);
  const reportedOffline = robot.presence === "OFFLINE";
  if (connectionOpen) {
    const displayState: DisplayState =
      reportedOffline || ageMs >= OFFLINE_SILENCE_MS ? "OFFLINE" : robot.state;
    const stale = displayState !== "OFFLINE" && ageMs >= map.staleAfterMs;
    return { robot, displayState, ageMs, stale, badges: badgesOf(robot, stale) };
  }
  const displayState: DisplayState = reportedOffline ? "OFFLINE" : robot.state;
  const stale = ageMs >= map.staleAfterMs;
  return { robot, displayState, ageMs, stale, badges: badgesOf(robot, stale) };
}

/**
 * Collects the badges of a robot in display order.
 *
 * @param robot - The robot.
 * @param stale - Whether the robot is stale.
 * @returns The badges that apply, in {@link BADGE_ORDER}.
 */
function badgesOf(robot: LiveRobot, stale: boolean): readonly BadgeKind[] {
  const active = new Set<BadgeKind>();
  if (robot.errorCode === "SENSOR_FAULT") {
    active.add("sensorFault");
  }
  if (robot.battery < BATTERY_LOW_PERCENT) {
    active.add("lowBattery");
  }
  if (stale) {
    active.add("stale");
  }
  return BADGE_ORDER.filter((kind) => active.has(kind));
}

/**
 * Counts the robots that are not OFFLINE.
 *
 * @param data - The live fleet.
 * @param now - Client time in milliseconds.
 * @param connectionOpen - Whether the realtime connection is open.
 * @returns The count, or `null` when the connection is closed or no robot is known (the status line then
 * shows "no data" rather than a misleading zero).
 */
export function robotsOnline(data: FleetData, now: number, connectionOpen: boolean): number | null {
  if (!connectionOpen) {
    return null;
  }
  const robots = Object.values(data.robots);
  if (robots.length === 0) {
    return null;
  }
  return robots.filter((robot) => robotView(robot, now, true).displayState !== "OFFLINE").length;
}

/**
 * Lists the robot identifiers in ascending order, so every list in the console has the same order.
 *
 * @param data - The live fleet.
 * @returns The identifiers.
 */
export function sortedRobotIds(data: FleetData): readonly string[] {
  return Object.keys(data.robots).sort();
}
