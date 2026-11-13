import { describe, expect, it } from "vitest";
import { RobotStateSchema } from "../src/index";

describe("RobotStateSchema", () => {
  it.each([
    "IDLE",
    "WORKING",
    "MOVING",
    "CHARGING",
    "BLOCKED",
    "PAUSED",
    "TELEOP",
    "ESTOP",
    "OFFLINE",
  ])("accepts %s", (value) => {
    expect(RobotStateSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["lowercase", "idle"],
    ["unknown state", "SLEEPING"],
    ["empty", ""],
    ["not a string", 1],
  ])("rejects %s", (_label, value) => {
    expect(RobotStateSchema.safeParse(value).success).toBe(false);
  });
});
