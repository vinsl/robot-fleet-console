/**
 * Rows of the robots list: one row per known robot, sorted by identifier, with the most urgent active alert of
 * each robot. Resolved alerts never appear on a row.
 */
import type { AlertRecord } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { robotRows } from "../../src/fleet/robots/robot-rows";
import { EMPTY_FILTER } from "../../src/live/fleet-filter-store";
import type { FleetData, LiveRobot } from "../../src/live/fleet-reducer";
import { alertOf, robotOf } from "../live/support";

const NOW = Date.parse("2026-11-03T10:00:00.000Z");

/**
 * Builds a fleet of the given robots.
 *
 * @param robots - The robots.
 * @returns The fleet.
 */
function fleetOf(robots: readonly LiveRobot[]): FleetData {
  return {
    robots: Object.fromEntries(robots.map((robot) => [robot.robotId, robot])),
    snapshotAt: null,
    session: { startedAt: NOW, missionsDone: [], stops: [], seenEventIds: [] },
    droppedRobots: 0,
  };
}

describe("robotRows", () => {
  it("sorts the rows by robot identifier, whatever the insertion order", () => {
    const fleet = fleetOf([
      robotOf({ robotId: "sim-03", lastHeardAt: NOW }),
      robotOf({ robotId: "sim-01", lastHeardAt: NOW }),
      robotOf({ robotId: "sim-02", lastHeardAt: NOW }),
    ]);
    const ids = robotRows(fleet, NOW, true, [], EMPTY_FILTER).map((row) => row.view.robot.robotId);
    expect(ids).toEqual(["sim-01", "sim-02", "sim-03"]);
  });

  it("gives each row the most urgent active alert severity of its robot", () => {
    const fleet = fleetOf([robotOf({ robotId: "sim-01", lastHeardAt: NOW })]);
    const alerts: readonly AlertRecord[] = [
      alertOf({ robotId: "sim-01", kind: "LOW_BATTERY", severity: "MINOR" }),
      alertOf({
        alertId: "0000000000000000000000000000000c",
        robotId: "sim-01",
        kind: "BLOCKED",
        severity: "MAJOR",
      }),
    ];
    const [row] = robotRows(fleet, NOW, true, alerts, EMPTY_FILTER);
    expect(row?.alertSeverity).toBe("MAJOR");
  });

  it("ignores resolved alerts when it reads the severity", () => {
    const fleet = fleetOf([robotOf({ robotId: "sim-01", lastHeardAt: NOW })]);
    const resolved = alertOf({
      robotId: "sim-01",
      status: "RESOLVED",
      openedAt: new Date(NOW - 60_000).toISOString(),
      acknowledgedBy: "11111111-2222-4333-8444-555555555555",
      acknowledgedAt: new Date(NOW - 30_000).toISOString(),
      resolvedBy: "11111111-2222-4333-8444-555555555555",
      resolvedAt: new Date(NOW).toISOString(),
    });
    const [row] = robotRows(fleet, NOW, true, [resolved], EMPTY_FILTER);
    expect(row?.alertSeverity).toBeNull();
  });
});
