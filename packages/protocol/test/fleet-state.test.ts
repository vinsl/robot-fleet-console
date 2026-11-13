/**
 * Live state records: the optional pose, the bounds copied from telemetry, and the persist interval.
 */
import { describe, expect, it } from "vitest";
import {
  LIVE_STATE_PERSIST_INTERVAL_MS,
  RobotLiveStateSchema,
  RobotPoseSchema,
} from "../src/index";

const LIVE_STATE_WITHOUT_POSE = {
  robotId: "kali-01",
  siteId: "paris-01",
  state: "MOVING",
  battery: 76,
  missionId: "pick-42",
  bootId: "0190a7c4-0000-7000-8000-000000000001",
  seq: 42,
  ts: "2026-11-02T10:00:00.000Z",
  receivedAt: 1_793_000_000_000,
};

const POSE = { x: 12.5, y: 3.25, heading: 0.5, speed: 0.8 };

const LIVE_STATE = { ...LIVE_STATE_WITHOUT_POSE, pose: POSE };

describe("LIVE_STATE_PERSIST_INTERVAL_MS", () => {
  it("is 10 seconds, the interval the persist policy relies on", () => {
    expect(LIVE_STATE_PERSIST_INTERVAL_MS).toBe(10_000);
  });
});

describe("RobotPoseSchema", () => {
  it("accepts a pose inside the telemetry bounds", () => {
    expect(RobotPoseSchema.safeParse(POSE).success).toBe(true);
  });

  it.each([
    ["an x beyond the bound", { x: 1001 }],
    ["a y below the bound", { y: -1001 }],
    ["a heading beyond pi", { heading: 3.2 }],
    ["a negative speed", { speed: -0.1 }],
    ["an extra key", { z: 0 }],
  ])("refuses %s", (_label, change) => {
    expect(RobotPoseSchema.safeParse({ ...POSE, ...change }).success).toBe(false);
  });
});

describe("RobotLiveStateSchema", () => {
  it("accepts a record with a pose", () => {
    expect(RobotLiveStateSchema.safeParse(LIVE_STATE).success).toBe(true);
  });

  it("accepts a record without a pose, as a heartbeat or a state event leaves it", () => {
    expect(RobotLiveStateSchema.safeParse(LIVE_STATE_WITHOUT_POSE).success).toBe(true);
  });

  it("accepts a record of an offline robot", () => {
    expect(RobotLiveStateSchema.safeParse({ ...LIVE_STATE, state: "OFFLINE" }).success).toBe(true);
  });

  it.each([
    ["a battery above 100", { battery: 101 }],
    ["an unknown state", { state: "SLEEPING" }],
    ["a malformed site", { siteId: "Paris" }],
    ["a boot identifier that is not a UUIDv7", { bootId: "00000000-0000-0000-0000-000000000000" }],
    ["a negative sequence", { seq: -1 }],
    ["a receive time that is negative", { receivedAt: -1 }],
    ["a receive time that is not an integer", { receivedAt: 1.5 }],
    ["a timestamp without milliseconds", { ts: "2026-11-02T10:00:00Z" }],
    ["a mission with upper case", { missionId: "Pick-42" }],
    ["an unknown fault code", { errorCode: "SMOKE" }],
    ["an extra key", { email: "ops@example.com" }],
  ])("refuses %s", (_label, change) => {
    expect(RobotLiveStateSchema.safeParse({ ...LIVE_STATE, ...change }).success).toBe(false);
  });
});
