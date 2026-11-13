/**
 * Shared vocabularies: reported states, fault codes, state-machine triggers, envelope bounds and
 * problem types.
 */
import { describe, expect, it } from "vitest";
import {
  FaultCodeSchema,
  PROBLEM_TYPES,
  ProblemSchema,
  RobotEnvelopeSchema,
  RobotReportedStateSchema,
  RobotStateSchema,
  TriggerSchema,
} from "../src/index";

describe("RobotReportedStateSchema", () => {
  it("is the robot state list without OFFLINE", () => {
    expect(RobotReportedStateSchema.options).toHaveLength(RobotStateSchema.options.length - 1);
    expect(RobotReportedStateSchema.safeParse("OFFLINE").success).toBe(false);
    expect(RobotReportedStateSchema.safeParse("ESTOP").success).toBe(true);
  });
});

describe("FaultCodeSchema", () => {
  it.each(["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"])("accepts %s", (code) => {
    expect(FaultCodeSchema.safeParse(code).success).toBe(true);
  });

  it("refuses an unknown fault", () => {
    expect(FaultCodeSchema.safeParse("ELECTRIC").success).toBe(false);
  });
});

describe("TriggerSchema", () => {
  it.each([
    "ESTOP",
    "HEARTBEAT",
    "SIMULATE_FAULT:LINK_LOSS",
    "SIMULATE_FAULT:OBSTACLE",
    "DEADMAN_EXPIRED",
    "LOCK_EXPIRED",
    "BOOT",
  ])("accepts the trigger %s", (trigger) => {
    expect(TriggerSchema.safeParse(trigger).success).toBe(true);
  });

  it.each([
    ["the unsupported DRIVE command", "DRIVE"],
    ["a fault outside the list", "SIMULATE_FAULT:ALIEN"],
    ["a cloud trigger, which the robot never acts on", "CLOUD_DISCONNECTED"],
  ])("refuses %s", (_label, trigger) => {
    expect(TriggerSchema.safeParse(trigger).success).toBe(false);
  });
});

describe("RobotEnvelopeSchema sequence", () => {
  const envelope = {
    schemaVersion: "1.0.0",
    messageId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
    robotId: "kali-01",
    siteId: "paris-01",
    ts: "2026-11-01T10:00:00.000Z",
    bootId: "0190a7c4-0000-7000-8000-000000000001",
  };

  it("accepts the largest safe integer as a sequence number", () => {
    expect(
      RobotEnvelopeSchema.safeParse({ ...envelope, seq: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
  });

  it("refuses a sequence number beyond the safe integer range", () => {
    expect(
      RobotEnvelopeSchema.safeParse({ ...envelope, seq: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
  });
});

describe("problem types", () => {
  it.each(PROBLEM_TYPES)("builds a problem type that the problem schema accepts: %s", (name) => {
    const problem = {
      type: `urn:mfc:problem:${name}`,
      title: "Title",
      status: 400,
      correlationId: "corr-0001-abcd",
    };
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it("refuses a problem type outside the urn namespace", () => {
    expect(
      ProblemSchema.safeParse({
        type: "about:blank",
        title: "Title",
        status: 400,
        correlationId: "corr-0001-abcd",
      }).success,
    ).toBe(false);
  });
});
