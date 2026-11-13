/**
 * Rows of the robots list: every known robot with its derived view and the most urgent alert it has, filtered and
 * sorted. Pure, so the sheet only renders and the rules are tested without a DOM.
 *
 * @module fleet/robots/robot-rows
 */
import { ALERT_SEVERITY_RANK, type AlertRecord, type AlertSeverity } from "@mfc/protocol";
import type { FleetData } from "../../live/fleet-reducer";
import { matchesFilter, type FleetFilter } from "../../live/fleet-filter-store";
import { robotView, type RobotView } from "../../live/fleet-selectors";

/** One row of the robots list. */
export interface RobotRow {
  /** The robot and its derived state, age and badges. */
  readonly view: RobotView;
  /** Severity of the most urgent active alert of the robot, or `null` when it has none. */
  readonly alertSeverity: AlertSeverity | null;
}

/**
 * Builds the rows of the list: one per known robot, in ascending robot identifier order, keeping the robots that
 * match the filter. The alert severity is taken from the active alerts only; a resolved alert is not a row
 * property.
 *
 * @param data - The live fleet.
 * @param now - Client time in milliseconds.
 * @param connectionOpen - Whether the realtime connection is open.
 * @param alerts - Active alerts (open and acknowledged).
 * @param filter - The criteria of the list.
 * @returns The rows, sorted by robot identifier.
 */
export function robotRows(
  data: FleetData,
  now: number,
  connectionOpen: boolean,
  alerts: readonly AlertRecord[],
  filter: FleetFilter,
): readonly RobotRow[] {
  const unresolved = alerts.filter((alert) => alert.status !== "RESOLVED");
  const severities = mostUrgentSeverities(unresolved);
  const openAlertRobotIds = new Set(unresolved.map((alert) => alert.robotId));
  const robots = Object.values(data.robots).sort((a, b) => compareIds(a.robotId, b.robotId));
  const rows: RobotRow[] = [];
  for (const robot of robots) {
    const view = robotView(robot, now, connectionOpen);
    if (!matchesFilter(view, filter, openAlertRobotIds)) {
      continue;
    }
    rows.push({ view, alertSeverity: severities.get(robot.robotId) ?? null });
  }
  return rows;
}

/**
 * Orders two robot identifiers by code unit, so the order does not depend on the browser locale.
 *
 * @param a - First identifier.
 * @param b - Second identifier.
 * @returns A negative number, zero or a positive number, as `Array.prototype.sort` expects.
 */
function compareIds(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Finds the most urgent severity per robot.
 *
 * @param alerts - Active alerts, none of them resolved.
 * @returns The severity per robot identifier.
 */
function mostUrgentSeverities(alerts: readonly AlertRecord[]): ReadonlyMap<string, AlertSeverity> {
  const severities = new Map<string, AlertSeverity>();
  for (const alert of alerts) {
    const current = severities.get(alert.robotId);
    if (
      current === undefined ||
      // eslint-disable-next-line security/detect-object-injection -- AlertSeverity is a closed protocol enum
      ALERT_SEVERITY_RANK[alert.severity] < ALERT_SEVERITY_RANK[current]
    ) {
      severities.set(alert.robotId, alert.severity);
    }
  }
  return severities;
}
