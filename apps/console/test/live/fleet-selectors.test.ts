/**
 * Derived robot views: silence rules with and without a connection, stale and battery badges, the online count.
 */
import { describe, expect, it } from "vitest";
import { OFFLINE_SILENCE_MS } from "@mfc/protocol";
import { emptyFleet, type FleetData } from "../../src/live/fleet-reducer";
import { robotView, robotsOnline, sortedRobotIds } from "../../src/live/fleet-selectors";
import { map } from "../../src/theme/tokens";
import { robotOf } from "./support";

const NOW = 100_000;

describe("robotView", () => {
  it("shows OFFLINE for a robot silent for the silence window while the connection is open", () => {
    const robot = robotOf({ state: "MOVING", lastHeardAt: NOW - OFFLINE_SILENCE_MS - 1 });
    const view = robotView(robot, NOW, true);
    expect(view.displayState).toBe("OFFLINE");
    expect(view.stale).toBe(false);
  });

  it("keeps the last state and only marks it stale while the connection is closed", () => {
    const robot = robotOf({ state: "MOVING", lastHeardAt: NOW - OFFLINE_SILENCE_MS - 1 });
    const view = robotView(robot, NOW, false);
    expect(view.displayState).toBe("MOVING");
    expect(view.stale).toBe(true);
    expect(view.badges).toEqual(["stale"]);
  });

  it("marks a robot stale after the stale threshold, without making it OFFLINE", () => {
    const robot = robotOf({ state: "MOVING", lastHeardAt: NOW - map.staleAfterMs });
    const view = robotView(robot, NOW, true);
    expect(view.displayState).toBe("MOVING");
    expect(view.stale).toBe(true);
    expect(view.badges).toContain("stale");
  });

  it("is not stale below the threshold", () => {
    const view = robotView(robotOf({ state: "IDLE", lastHeardAt: NOW - 1_000 }), NOW, true);
    expect(view.stale).toBe(false);
    expect(view.badges).toEqual([]);
  });

  it("shows OFFLINE when the cloud reports the robot offline, whatever the age", () => {
    const view = robotView(
      robotOf({ presence: "OFFLINE", state: "IDLE", lastHeardAt: NOW }),
      NOW,
      true,
    );
    expect(view.displayState).toBe("OFFLINE");
  });

  it("adds a low battery badge below the threshold only", () => {
    expect(robotView(robotOf({ battery: 19, lastHeardAt: NOW }), NOW, true).badges).toEqual([
      "lowBattery",
    ]);
    expect(robotView(robotOf({ battery: 20, lastHeardAt: NOW }), NOW, true).badges).toEqual([]);
  });

  it("adds a sensor fault badge for a sensor fault", () => {
    const view = robotView(robotOf({ errorCode: "SENSOR_FAULT", lastHeardAt: NOW }), NOW, true);
    expect(view.badges).toEqual(["sensorFault"]);
  });

  it("orders the badges by the display order", () => {
    const view = robotView(
      robotOf({ errorCode: "SENSOR_FAULT", battery: 5, lastHeardAt: NOW - map.staleAfterMs }),
      NOW,
      true,
    );
    expect(view.badges).toEqual(["sensorFault", "lowBattery", "stale"]);
  });

  it("never reports a negative age", () => {
    expect(robotView(robotOf({ lastHeardAt: NOW + 500 }), NOW, true).ageMs).toBe(0);
  });
});

describe("robotsOnline", () => {
  /**
   * Builds a fleet from robots.
   *
   * @param robots - The robots.
   * @returns The fleet.
   */
  function fleetOf(...robots: ReturnType<typeof robotOf>[]): FleetData {
    const byId: Record<string, ReturnType<typeof robotOf>> = {};
    for (const robot of robots) {
      byId[robot.robotId] = robot;
    }
    return { ...emptyFleet(0), robots: byId };
  }

  it("is null while the connection is closed", () => {
    expect(robotsOnline(fleetOf(robotOf({ lastHeardAt: NOW })), NOW, false)).toBeNull();
  });

  it("is null when no robot is known", () => {
    expect(robotsOnline(emptyFleet(0), NOW, true)).toBeNull();
  });

  it("counts the robots that are not OFFLINE", () => {
    const fleet = fleetOf(
      robotOf({ robotId: "sim-01", lastHeardAt: NOW }),
      robotOf({ robotId: "sim-02", lastHeardAt: NOW - OFFLINE_SILENCE_MS - 1 }),
      robotOf({ robotId: "sim-03", lastHeardAt: NOW - map.staleAfterMs }),
    );
    expect(robotsOnline(fleet, NOW, true)).toBe(2);
  });
});

describe("sortedRobotIds", () => {
  it("lists the identifiers in ascending order", () => {
    const fleet: FleetData = {
      ...emptyFleet(0),
      robots: {
        "sim-10": robotOf({ robotId: "sim-10" }),
        "sim-02": robotOf({ robotId: "sim-02" }),
      },
    };
    expect(sortedRobotIds(fleet)).toEqual(["sim-02", "sim-10"]);
  });
});
