/**
 * The KPI definitions: availability, missions per hour, error rate, interventions and MTTR. Each rule is checked
 * on a small fleet built from the live fixtures, so the numbers in the assertions can be checked by hand.
 */
import type { AlertRecord } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  availability,
  computeKpis,
  errorRate,
  formatPercent,
  percentParts,
  interventionsPerRobot,
  missionsPerHour,
  mttrMs,
  type KpiInputs,
} from "../../src/kpi/kpi";
import type { FleetData, LiveRobot, SessionLog } from "../../src/live/fleet-reducer";
import { alertOf, robotOf } from "../live/support";

const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const USER = "11111111-2222-4333-8444-555555555555";
/** Opening time of the alerts used in the acknowledgement tests, before any acknowledgement of them. */
const OPENED_AT = new Date(NOW - 26 * HOUR).toISOString();

/**
 * Builds a valid alert identifier from a small number.
 *
 * @param n - The number, written in hexadecimal at the end of the identifier.
 * @returns A 32-character lower-case hexadecimal identifier.
 */
function alertIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

/**
 * Builds a fleet from robots and a session log.
 *
 * @param robots - The robots, in any order.
 * @param session - The session fields to set; the rest is empty.
 * @returns The fleet.
 */
function fleetOf(robots: readonly LiveRobot[], session: Partial<SessionLog> = {}): FleetData {
  return {
    robots: Object.fromEntries(robots.map((robot) => [robot.robotId, robot])),
    snapshotAt: null,
    session: {
      startedAt: NOW - HOUR,
      missionsDone: [],
      stops: [],
      seenEventIds: [],
      ...session,
    },
    droppedRobots: 0,
  };
}

/**
 * Builds ten robots that are heard now, all IDLE except the ones named.
 *
 * @param overrides - The fields to change, by robot identifier.
 * @returns Ten robots, sim-01 to sim-10.
 */
function tenRobots(overrides: ReadonlyMap<string, Partial<LiveRobot>> = new Map()): LiveRobot[] {
  return Array.from({ length: 10 }, (_, index) => {
    const robotId = `sim-${String(index + 1).padStart(2, "0")}`;
    return robotOf({ robotId, lastHeardAt: NOW, ...overrides.get(robotId) });
  });
}

/**
 * Builds the KPI inputs of an open connection.
 *
 * @param fleet - The fleet.
 * @param lists - The active and resolved alerts.
 * @returns The inputs.
 */
function inputsOf(
  fleet: FleetData,
  lists: {
    readonly active?: readonly AlertRecord[];
    readonly resolved?: readonly AlertRecord[];
  } = {},
): KpiInputs {
  return {
    fleet,
    now: NOW,
    connectionOpen: true,
    active: lists.active ?? [],
    resolved: lists.resolved ?? [],
  };
}

describe("availability", () => {
  it("is the share of robots that are not OFFLINE, BLOCKED or ESTOP: 8 of 10", () => {
    const fleet = fleetOf(
      tenRobots(
        new Map([
          ["sim-02", { state: "BLOCKED" }],
          ["sim-03", { presence: "OFFLINE" }],
        ]),
      ),
    );
    expect(availability(inputsOf(fleet))).toBe(0.8);
  });

  it("counts a robot silent for 15 s as OFFLINE while the connection is open", () => {
    const fleet = fleetOf(tenRobots(new Map([["sim-04", { lastHeardAt: NOW - 16_000 }]])));
    expect(availability(inputsOf(fleet))).toBe(0.9);
  });

  it("is null when the connection is closed", () => {
    const fleet = fleetOf(tenRobots());
    expect(availability({ ...inputsOf(fleet), connectionOpen: false })).toBeNull();
  });

  it("is null when no robot is known", () => {
    expect(availability(inputsOf(fleetOf([])))).toBeNull();
  });
});

describe("missionsPerHour", () => {
  it("is null before the five-minute warm-up and still reports the count", () => {
    const fleet = fleetOf(tenRobots(), {
      startedAt: NOW - 4 * MINUTE,
      missionsDone: [NOW - MINUTE, NOW - 2 * MINUTE, NOW - 3 * MINUTE],
    });
    expect(missionsPerHour(inputsOf(fleet))).toEqual({ perHour: null, count: 3, minutes: 4 });
  });

  it("is 24 per hour for 12 missions in the last 30 minutes of the session", () => {
    const missionsDone = Array.from({ length: 12 }, (_, index) => NOW - (index + 1) * MINUTE);
    const fleet = fleetOf(tenRobots(), { startedAt: NOW - 30 * MINUTE, missionsDone });
    expect(missionsPerHour(inputsOf(fleet))).toEqual({ perHour: 24, count: 12, minutes: 30 });
  });

  it("ignores missions older than the session window", () => {
    const fleet = fleetOf(tenRobots(), {
      startedAt: NOW - 30 * MINUTE,
      missionsDone: [NOW - 45 * MINUTE, NOW - MINUTE],
    });
    expect(missionsPerHour(inputsOf(fleet)).count).toBe(1);
  });
});

describe("errorRate", () => {
  it("is 2 stops over 10 (8 missions and 2 stops) = 0.2", () => {
    const fleet = fleetOf(tenRobots(), {
      startedAt: NOW - HOUR,
      missionsDone: Array.from({ length: 8 }, (_, index) => NOW - (index + 1) * MINUTE),
      stops: [NOW - 20 * MINUTE, NOW - 21 * MINUTE],
    });
    expect(errorRate(inputsOf(fleet))).toBe(0.2);
  });

  it("is null when the session has no mission and no stop", () => {
    expect(errorRate(inputsOf(fleetOf(tenRobots())))).toBeNull();
  });
});

describe("interventionsPerRobot", () => {
  it("is 3 acknowledged alerts over 10 robots = 0.3", () => {
    const acknowledged = [1, 2, 3].map((index) =>
      alertOf({
        alertId: alertIdOf(index),
        openedAt: OPENED_AT,
        status: "ACKNOWLEDGED",
        acknowledgedBy: USER,
        acknowledgedAt: new Date(NOW - index * MINUTE).toISOString(),
      }),
    );
    const fleet = fleetOf(tenRobots());
    expect(interventionsPerRobot(inputsOf(fleet, { active: acknowledged }))).toBe(0.3);
  });

  it("does not count an acknowledgement older than 24 hours", () => {
    const old = alertOf({
      openedAt: OPENED_AT,
      status: "ACKNOWLEDGED",
      acknowledgedBy: USER,
      acknowledgedAt: new Date(NOW - 25 * HOUR).toISOString(),
    });
    expect(interventionsPerRobot(inputsOf(fleetOf(tenRobots()), { active: [old] }))).toBe(0);
  });

  it("counts an alert once when it is in both lists, the resolved entry winning", () => {
    const acknowledgedAt = new Date(NOW - MINUTE).toISOString();
    const base = {
      openedAt: OPENED_AT,
      status: "ACKNOWLEDGED" as const,
      acknowledgedBy: USER,
      acknowledgedAt,
    };
    const active = alertOf(base);
    const resolved = alertOf({
      ...base,
      status: "RESOLVED",
      resolvedBy: USER,
      resolvedAt: new Date(NOW).toISOString(),
    });
    expect(
      interventionsPerRobot(
        inputsOf(fleetOf(tenRobots()), { active: [active], resolved: [resolved] }),
      ),
    ).toBe(0.1);
  });

  it("is null when no robot is known", () => {
    expect(interventionsPerRobot(inputsOf(fleetOf([])))).toBeNull();
  });
});

describe("mttrMs", () => {
  it("is the mean of the opening-to-resolution times of two alerts resolved in 24 hours", () => {
    const first = alertOf({
      alertId: alertIdOf(10),
      status: "RESOLVED",
      openedAt: new Date(NOW - 30 * MINUTE).toISOString(),
      acknowledgedBy: USER,
      acknowledgedAt: new Date(NOW - 29 * MINUTE).toISOString(),
      resolvedBy: USER,
      resolvedAt: new Date(NOW - 29 * MINUTE + 60_000).toISOString(),
    });
    const second = alertOf({
      alertId: alertIdOf(11),
      status: "RESOLVED",
      openedAt: new Date(NOW - 20 * MINUTE).toISOString(),
      acknowledgedBy: USER,
      acknowledgedAt: new Date(NOW - 19 * MINUTE).toISOString(),
      resolvedBy: USER,
      resolvedAt: new Date(NOW - 10 * MINUTE).toISOString(),
    });
    // First: opened 30 min ago, resolved 28 min ago (2 min). Second: opened 20 min ago, resolved 10 min ago (10 min).
    expect(mttrMs(inputsOf(fleetOf(tenRobots()), { resolved: [first, second] }))).toBe(6 * MINUTE);
  });

  it("is null when no alert was resolved in the last 24 hours", () => {
    expect(mttrMs(inputsOf(fleetOf(tenRobots())))).toBeNull();
  });
});

describe("computeKpis and formatPercent", () => {
  it("computes every value from one set of inputs", () => {
    const values = computeKpis(inputsOf(fleetOf(tenRobots())));
    expect(values.availability).toBe(1);
    expect(values.errorRate).toBeNull();
    expect(values.mttrMs).toBeNull();
  });

  it("formats a ratio as a whole percentage in the UI language", () => {
    expect(formatPercent(0.8, "en")).toBe("80%");
    expect(formatPercent(0.9, "fr").replace(/\s/g, " ")).toMatch(/^90\s?%$/);
  });
});

describe("percentParts", () => {
  it("splits the digits from the percent sign in English", () => {
    expect(percentParts(0.964, "en")).toEqual({ number: "96", unit: "%" });
  });

  it("drops the French space before the percent sign, so the unit sits against the digits", () => {
    expect(percentParts(0.964, "fr")).toEqual({ number: "96", unit: "%" });
  });
});
