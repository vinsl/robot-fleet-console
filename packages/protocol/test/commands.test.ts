/**
 * Command vocabulary: the lock partition, the unsupported set, and the parameter bounds of each type.
 */
import { describe, expect, it } from "vitest";
import {
  CommandSchema,
  CommandTypeSchema,
  LOCK_FREE_COMMANDS,
  LOCK_REQUIRED_COMMANDS,
  UNSUPPORTED_COMMANDS,
} from "../src/index";

const BASE = {
  schemaVersion: "1.0.0",
  messageId: "0190a7c5-2b00-7c00-8a00-00000000a001",
  robotId: "kali-01",
  siteId: "paris-01",
  ts: "2026-11-01T10:00:01.000Z",
  commandId: "0190a7c5-1f00-7a00-8b00-00000000c001",
  issuedAt: "2026-11-01T10:00:00.900Z",
  issuedBy: "7f3e2a10-9b4c-4d5e-8f60-1a2b3c4d5e6f",
  correlationId: "corr-0001-abcd",
};

describe("lock partition", () => {
  it("assigns every command type to exactly one of the two lists", () => {
    const required = new Set<string>(LOCK_REQUIRED_COMMANDS);
    const free = new Set<string>(LOCK_FREE_COMMANDS);
    for (const type of CommandTypeSchema.options) {
      expect(required.has(type) !== free.has(type), type).toBe(true);
    }
    expect(required.size + free.size).toBe(CommandTypeSchema.options.length);
  });

  it("keeps ESTOP and SIMULATE_FAULT free of the lock, so that an operator can always stop a robot", () => {
    expect(LOCK_FREE_COMMANDS).toContain("ESTOP");
    expect(LOCK_FREE_COMMANDS).toContain("SIMULATE_FAULT");
  });

  it("lists only known command types as unsupported", () => {
    for (const type of UNSUPPORTED_COMMANDS) {
      expect(CommandTypeSchema.options).toContain(type);
    }
  });
});

describe("CommandSchema parameters", () => {
  it.each([
    ["linear above 1", { linear: 1.01, angular: 0, durationMs: 100 }],
    ["angular below -1.5", { linear: 0, angular: -1.51, durationMs: 100 }],
    ["duration below 50 ms", { linear: 0, angular: 0, durationMs: 49 }],
    ["duration above 500 ms", { linear: 0, angular: 0, durationMs: 501 }],
    ["fractional duration", { linear: 0, angular: 0, durationMs: 100.5 }],
  ])("refuses a DRIVE with %s", (_label, params) => {
    const result = CommandSchema.safeParse({
      ...BASE,
      type: "DRIVE",
      lockToken: "lock-token-0001-abcd",
      params,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["duration above 300 s", { fault: "OBSTACLE", durationS: 301 }],
    ["duration of zero", { fault: "OBSTACLE", durationS: 0 }],
    ["unknown fault", { fault: "ALIEN" }],
  ])("refuses a SIMULATE_FAULT with %s", (_label, params) => {
    expect(CommandSchema.safeParse({ ...BASE, type: "SIMULATE_FAULT", params }).success).toBe(
      false,
    );
  });

  it("accepts a SIMULATE_FAULT without a duration", () => {
    expect(
      CommandSchema.safeParse({ ...BASE, type: "SIMULATE_FAULT", params: { fault: "LINK_LOSS" } })
        .success,
    ).toBe(true);
  });

  it("refuses TAKE_CONTROL without a lock token, which is what the lock is granted to", () => {
    expect(CommandSchema.safeParse({ ...BASE, type: "TAKE_CONTROL", params: {} }).success).toBe(
      false,
    );
  });

  it("refuses a command with parameters that are not in its type, even when they are harmless", () => {
    expect(
      CommandSchema.safeParse({ ...BASE, type: "ESTOP", params: { reason: "ok" } }).success,
    ).toBe(false);
  });
});
