/**
 * Pure reducer of the live fleet: ordering, presence, duplicate events, the session log and marker motion.
 */
import { describe, expect, it } from "vitest";
import { SNAPSHOT_MAX_ROBOTS } from "@mfc/protocol";
import {
  emptyFleet,
  applyFrame,
  nextMotion,
  poseAt,
  type FleetData,
  type Motion,
} from "../../src/live/fleet-reducer";
import { tokens } from "../../src/theme/tokens";
import { BOOT_NEW, deltaOf, eventOf, presenceOf, robotOf, sampleOf, snapshotOf } from "./support";

const NOW = 1_000_000;
const MESSAGE_A = "0190f3a2-7b1c-7000-8000-0000000000a1";
const MESSAGE_B = "0190f3a2-7b1c-7000-8000-0000000000b2";
const MESSAGE_C = "0190f3a2-7b1c-7000-8000-0000000000c3";

/**
 * Applies frames in order, starting from an empty fleet.
 *
 * @param frames - Frames with their client times.
 * @returns The fleet after the last frame.
 */
function run(
  frames: readonly { frame: Parameters<typeof applyFrame>[1]; at: number }[],
): FleetData {
  let data = emptyFleet(0);
  for (const { frame, at } of frames) {
    data = applyFrame(data, frame, at);
  }
  return data;
}

describe("emptyFleet", () => {
  it("starts with no robot, no snapshot and an empty session at the given time", () => {
    expect(emptyFleet(NOW)).toEqual({
      robots: {},
      snapshotAt: null,
      session: { startedAt: NOW, missionsDone: [], stops: [], seenEventIds: [] },
      droppedRobots: 0,
    });
  });
});

describe("snapshot", () => {
  it("inserts the robots, marks an OFFLINE record as offline and records the snapshot time", () => {
    const data = run([
      {
        frame: snapshotOf({ robotId: "sim-01", state: "IDLE", receivedAt: NOW - 500 }),
        at: NOW,
      },
      {
        frame: snapshotOf({ robotId: "sim-02", state: "OFFLINE", receivedAt: NOW - 100 }),
        at: NOW,
      },
    ]);
    expect(data.snapshotAt).toBe(NOW);
    expect(data.robots["sim-01"]?.presence).toBe("ONLINE");
    expect(data.robots["sim-01"]?.lastHeardAt).toBe(NOW - 500);
    expect(data.robots["sim-02"]?.presence).toBe("OFFLINE");
  });

  it("does not let an older snapshot overwrite a newer delta", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 5, { state: "MOVING" })]), at: NOW },
      {
        frame: snapshotOf({ robotId: "sim-01", seq: 3, state: "IDLE", receivedAt: NOW }),
        at: NOW + 10,
      },
    ]);
    expect(data.robots["sim-01"]?.state).toBe("MOVING");
    expect(data.robots["sim-01"]?.seq).toBe(5);
  });

  it("keeps the last known pose when a record carries none, and snaps when it carries one", () => {
    const withPose = run([
      {
        frame: snapshotOf({
          robotId: "sim-01",
          receivedAt: NOW,
          pose: { x: 1, y: 1, heading: 0, speed: 0 },
        }),
        at: NOW,
      },
      { frame: snapshotOf({ robotId: "sim-01", seq: 2, receivedAt: NOW }), at: NOW + 1 },
    ]);
    expect(withPose.robots["sim-01"]?.pose).toEqual({ x: 1, y: 1, heading: 0, speed: 0 });
    expect(withPose.robots["sim-01"]?.motion).toBeNull();
  });

  it("refreshes the contact time of a record that repeats the held sample, and nothing else", () => {
    const first = run([
      {
        frame: snapshotOf({
          robotId: "sim-01",
          seq: 4,
          state: "MOVING",
          battery: 55,
          receivedAt: NOW - 500,
          pose: { x: 3, y: 4, heading: 0.5, speed: 0.2 },
        }),
        at: NOW,
      },
    ]);
    const second = applyFrame(
      first,
      snapshotOf({ robotId: "sim-01", seq: 4, state: "IDLE", battery: 10, receivedAt: NOW + 90 }),
      NOW + 100,
    );
    const held = first.robots["sim-01"];
    const refreshed = second.robots["sim-01"];
    expect(refreshed?.lastHeardAt).toBe(NOW + 90);
    expect(refreshed).toEqual({ ...held, lastHeardAt: NOW + 90 });
    expect(refreshed?.state).toBe("MOVING");
    expect(refreshed?.battery).toBe(55);
  });

  it("never moves the contact time backwards when a repeated record carries an older receive time", () => {
    const first = run([
      { frame: snapshotOf({ robotId: "sim-01", seq: 4, receivedAt: NOW }), at: NOW },
    ]);
    const second = applyFrame(
      first,
      snapshotOf({ robotId: "sim-01", seq: 4, receivedAt: NOW - 300 }),
      NOW + 10,
    );
    expect(second.robots["sim-01"]?.lastHeardAt).toBe(NOW);
  });
});

describe("delta", () => {
  it("ignores a sample that is not newer than the one held, and returns the same object", () => {
    const first = applyFrame(emptyFleet(0), deltaOf([sampleOf("sim-01", 5)]), NOW);
    const second = applyFrame(
      first,
      deltaOf([sampleOf("sim-01", 4, { state: "BLOCKED" })]),
      NOW + 1,
    );
    expect(second).toBe(first);
    expect(second.robots["sim-01"]?.state).toBe("MOVING");
  });

  it("accepts a new boot with a lower sequence number", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 90)]), at: NOW },
      { frame: deltaOf([sampleOf("sim-01", 1, { bootId: BOOT_NEW, state: "IDLE" })]), at: NOW + 1 },
    ]);
    expect(data.robots["sim-01"]?.bootId).toBe(BOOT_NEW);
    expect(data.robots["sim-01"]?.seq).toBe(1);
    expect(data.robots["sim-01"]?.state).toBe("IDLE");
  });

  it("brings an OFFLINE robot back ONLINE with the next sample", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      { frame: presenceOf("sim-01", "OFFLINE"), at: NOW + 1 },
      { frame: deltaOf([sampleOf("sim-01", 2)]), at: NOW + 2 },
    ]);
    expect(data.robots["sim-01"]?.presence).toBe("ONLINE");
  });

  it("interpolates the marker towards the new pose", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1, { x: 0, y: 0 })]), at: NOW },
      { frame: deltaOf([sampleOf("sim-01", 2, { x: 1, y: 0 })]), at: NOW + 500 },
    ]);
    const motion = data.robots["sim-01"]?.motion;
    expect(motion?.from).toMatchObject({ x: 0, y: 0 });
    expect(motion?.to).toMatchObject({ x: 1, y: 0 });
    expect(motion?.toAt).toBe(NOW + 500 + 500);
  });
});

describe("presence", () => {
  it("keeps the time of the last contact when a robot goes OFFLINE", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      { frame: presenceOf("sim-01", "OFFLINE"), at: NOW + 9_000 },
    ]);
    expect(data.robots["sim-01"]).toMatchObject({ presence: "OFFLINE", lastHeardAt: NOW });
  });

  it("returns the same object for a robot that is not known", () => {
    const empty = emptyFleet(0);
    expect(applyFrame(empty, presenceOf("sim-09", "ONLINE"), NOW)).toBe(empty);
  });
});

describe("robot events", () => {
  it("counts a duplicated event once", () => {
    const frame = eventOf("sim-01", MESSAGE_A, 2, {
      kind: "STATE_CHANGED",
      from: "WORKING",
      to: "IDLE",
      cause: "WORK_DONE",
    });
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      { frame, at: NOW + 1 },
      { frame, at: NOW + 2 },
    ]);
    expect(data.session.missionsDone).toEqual([NOW + 1]);
    expect(data.session.seenEventIds).toEqual([MESSAGE_A]);
  });

  it("counts a finished mission when the robot returns to IDLE after work", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      {
        frame: eventOf("sim-01", MESSAGE_A, 2, {
          kind: "STATE_CHANGED",
          from: "WORKING",
          to: "IDLE",
          cause: "WORK_DONE",
        }),
        at: NOW + 1,
      },
    ]);
    expect(data.session.missionsDone).toEqual([NOW + 1]);
    expect(data.robots["sim-01"]?.state).toBe("IDLE");
  });

  it("counts a stop when a robot enters BLOCKED or ESTOP", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      {
        frame: eventOf("sim-01", MESSAGE_A, 2, {
          kind: "STATE_CHANGED",
          from: "MOVING",
          to: "BLOCKED",
          cause: "OBSTACLE_DETECTED",
        }),
        at: NOW + 1,
      },
      {
        frame: eventOf("sim-01", MESSAGE_B, 3, {
          kind: "STATE_CHANGED",
          from: "BLOCKED",
          to: "ESTOP",
          cause: "OBSTACLE_DETECTED",
        }),
        at: NOW + 2,
      },
    ]);
    expect(data.session.stops).toEqual([NOW + 1, NOW + 2]);
  });

  it("trims the session logs to the last hour", () => {
    const hour = tokens.live.sessionWindowMs;
    const data = run([
      {
        frame: eventOf("sim-01", MESSAGE_A, 1, {
          kind: "STATE_CHANGED",
          from: "MOVING",
          to: "BLOCKED",
          cause: "OBSTACLE_DETECTED",
        }),
        at: NOW,
      },
      {
        frame: eventOf("sim-01", MESSAGE_B, 2, {
          kind: "STATE_CHANGED",
          from: "MOVING",
          to: "ESTOP",
          cause: "OBSTACLE_DETECTED",
        }),
        at: NOW + hour + 1,
      },
    ]);
    expect(data.session.stops).toEqual([NOW + hour + 1]);
  });

  it("applies a fault raised then cleared, but only clears the fault it names", () => {
    const base = run([{ frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW }]);
    const raised = applyFrame(
      base,
      eventOf("sim-01", MESSAGE_A, 2, { kind: "FAULT_RAISED", fault: "SENSOR_FAULT" }),
      NOW + 1,
    );
    expect(raised.robots["sim-01"]?.errorCode).toBe("SENSOR_FAULT");
    const otherCleared = applyFrame(
      raised,
      eventOf("sim-01", MESSAGE_B, 3, { kind: "FAULT_CLEARED", fault: "BATTERY_LOW" }),
      NOW + 2,
    );
    expect(otherCleared.robots["sim-01"]?.errorCode).toBe("SENSOR_FAULT");
    const cleared = applyFrame(
      raised,
      eventOf("sim-01", MESSAGE_C, 3, { kind: "FAULT_CLEARED", fault: "SENSOR_FAULT" }),
      NOW + 2,
    );
    expect(cleared.robots["sim-01"]?.errorCode).toBeUndefined();
  });

  it("takes state and battery from a heartbeat and presence from a boot", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 1)]), at: NOW },
      { frame: presenceOf("sim-01", "OFFLINE"), at: NOW + 1 },
      {
        frame: eventOf("sim-01", MESSAGE_A, 2, {
          kind: "HEARTBEAT",
          state: "CHARGING",
          battery: 42,
        }),
        at: NOW + 2,
      },
      {
        frame: eventOf(
          "sim-01",
          MESSAGE_B,
          1,
          { kind: "BOOT", agentVersion: "1.0.0", simulated: true, state: "IDLE" },
          BOOT_NEW,
        ),
        at: NOW + 3,
      },
    ]);
    expect(data.robots["sim-01"]).toMatchObject({
      state: "IDLE",
      battery: 42,
      presence: "ONLINE",
      bootId: BOOT_NEW,
    });
  });

  it("creates no entry for an unknown robot but still counts its stop", () => {
    const data = run([
      {
        frame: eventOf("sim-09", MESSAGE_A, 1, {
          kind: "STATE_CHANGED",
          from: "MOVING",
          to: "BLOCKED",
          cause: "OBSTACLE_DETECTED",
        }),
        at: NOW,
      },
    ]);
    expect(data.robots).toEqual({});
    expect(data.session.stops).toEqual([NOW]);
  });

  it("refreshes the last contact but keeps the state of an older event", () => {
    const data = run([
      { frame: deltaOf([sampleOf("sim-01", 5, { state: "MOVING" })]), at: NOW },
      {
        frame: eventOf("sim-01", MESSAGE_A, 2, {
          kind: "STATE_CHANGED",
          from: "MOVING",
          to: "IDLE",
          cause: "WORK_DONE",
        }),
        at: NOW + 4_000,
      },
    ]);
    expect(data.robots["sim-01"]).toMatchObject({ state: "MOVING", lastHeardAt: NOW + 4_000 });
  });
});

/**
 * Builds a list of robot identifiers in the protocol grammar.
 *
 * @param count - How many identifiers.
 * @returns `sim-00`, `sim-01`, ... for the first `count` robots.
 */
function robotIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `sim-${String(index).padStart(2, "0")}`);
}

describe("robot cap", () => {
  it("refuses a new robot from a snapshot once the fleet holds SNAPSHOT_MAX_ROBOTS, and counts it", () => {
    const filled = robotIds(SNAPSHOT_MAX_ROBOTS).reduce<FleetData>((data, robotId) => {
      return applyFrame(data, snapshotOf({ robotId, seq: 1, receivedAt: NOW }), NOW);
    }, emptyFleet(0));
    expect(Object.keys(filled.robots)).toHaveLength(SNAPSHOT_MAX_ROBOTS);
    expect(filled.droppedRobots).toBe(0);

    const flood = applyFrame(filled, snapshotOf({ robotId: "sim-99", seq: 1 }), NOW + 1);
    expect(flood.robots["sim-99"]).toBeUndefined();
    expect(Object.keys(flood.robots)).toHaveLength(SNAPSHOT_MAX_ROBOTS);
    expect(flood.droppedRobots).toBe(1);
  });

  it("still updates a robot already held when the fleet is full", () => {
    const filled = robotIds(SNAPSHOT_MAX_ROBOTS).reduce<FleetData>((data, robotId) => {
      return applyFrame(data, snapshotOf({ robotId, seq: 1, receivedAt: NOW }), NOW);
    }, emptyFleet(0));
    const updated = applyFrame(
      filled,
      deltaOf([sampleOf("sim-00", 2, { state: "BLOCKED" })]),
      NOW + 1,
    );
    expect(updated.robots["sim-00"]?.state).toBe("BLOCKED");
    expect(updated.droppedRobots).toBe(0);
  });

  it("refuses the robots of a delta flood beyond the cap and keeps the admitted ones", () => {
    const ids = robotIds(SNAPSHOT_MAX_ROBOTS + 10);
    const data = applyFrame(
      emptyFleet(0),
      deltaOf(ids.map((robotId) => sampleOf(robotId, 1))),
      NOW,
    );
    expect(Object.keys(data.robots)).toHaveLength(SNAPSHOT_MAX_ROBOTS);
    expect(data.robots["sim-59"]).toBeDefined();
    expect(data.robots["sim-60"]).toBeUndefined();
    expect(data.droppedRobots).toBe(10);
  });

  it("counts each refused arrival of the same robot, since a refused robot is never held", () => {
    const full = robotIds(SNAPSHOT_MAX_ROBOTS).reduce<FleetData>((data, robotId) => {
      return applyFrame(data, snapshotOf({ robotId, seq: 1, receivedAt: NOW }), NOW);
    }, emptyFleet(0));
    const once = applyFrame(full, deltaOf([sampleOf("sim-70", 1)]), NOW + 1);
    const twice = applyFrame(once, deltaOf([sampleOf("sim-70", 2)]), NOW + 2);
    expect(twice.robots["sim-70"]).toBeUndefined();
    expect(twice.droppedRobots).toBe(2);
  });
});

describe("unchanged frames", () => {
  it("returns the same object for frames that do not change the fleet", () => {
    const data = applyFrame(emptyFleet(0), deltaOf([sampleOf("sim-01", 1)]), NOW);
    const error = applyFrame(data, { type: "error", code: "INVALID_MESSAGE" }, NOW + 1);
    expect(error).toBe(data);
  });
});

describe("nextMotion and poseAt", () => {
  const pose = { x: 1, y: 0, heading: 0, speed: 0.2 };

  it("snaps for the first pose", () => {
    expect(nextMotion(undefined, pose, false, NOW)).toBeNull();
    expect(nextMotion(robotOf({ pose: null }), pose, false, NOW)).toBeNull();
  });

  it("snaps for a jump of more than five metres and for a new boot", () => {
    const robot = robotOf({ pose: { x: 0, y: 0, heading: 0, speed: 0 }, lastSampleAt: NOW - 100 });
    expect(nextMotion(robot, { ...pose, x: 6 }, false, NOW)).toBeNull();
    expect(nextMotion(robot, pose, true, NOW)).toBeNull();
  });

  it("clamps the interpolation duration to the configured window", () => {
    const base = { pose: { x: 0, y: 0, heading: 0, speed: 0 } };
    const quick = nextMotion(robotOf({ ...base, lastSampleAt: NOW - 100 }), pose, false, NOW);
    const slow = nextMotion(robotOf({ ...base, lastSampleAt: NOW - 10_000 }), pose, false, NOW);
    const middle = nextMotion(robotOf({ ...base, lastSampleAt: NOW - 1_000 }), pose, false, NOW);
    expect(quick?.toAt).toBe(NOW + tokens.map.interpolationMinMs);
    expect(slow?.toAt).toBe(NOW + tokens.map.interpolationMaxMs);
    expect(middle?.toAt).toBe(NOW + 1_000);
  });

  it("starts from the pose drawn now when a motion is in progress", () => {
    const motion: Motion = {
      from: { x: 0, y: 0, heading: 0, speed: 0 },
      fromAt: NOW - 1_000,
      to: { x: 1, y: 0, heading: 0, speed: 0 },
      toAt: NOW + 1_000,
    };
    const robot = robotOf({ pose: motion.to, motion, lastSampleAt: NOW - 1_000 });
    const next = nextMotion(robot, { ...pose, x: 2 }, false, NOW);
    expect(next?.from.x).toBeCloseTo(0.5, 9);
  });

  it("interpolates the heading along the short arc across the -pi/pi seam", () => {
    const motion: Motion = {
      from: { x: 0, y: 0, heading: 3.1, speed: 0 },
      fromAt: 0,
      to: { x: 0, y: 0, heading: -3.1, speed: 0 },
      toAt: 1_000,
    };
    expect(poseAt(motion, 1_000).heading).toBeCloseTo(-3.1, 9);
    expect(Math.abs(poseAt(motion, 500).heading)).toBeGreaterThan(3.1);
  });

  it("clamps the draw time to the motion", () => {
    const motion: Motion = {
      from: { x: 0, y: 0, heading: 0, speed: 0 },
      fromAt: 100,
      to: { x: 10, y: 0, heading: 0, speed: 0 },
      toAt: 200,
    };
    expect(poseAt(motion, 0).x).toBe(0);
    expect(poseAt(motion, 999).x).toBe(10);
  });
});
