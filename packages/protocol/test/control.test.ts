/**
 * Control plane HTTP contract: the command request by type, the lock state and its invariants, the answers
 * and the demo mode. Every schema is strict, and the lock token never appears in any of them.
 */
import { describe, expect, it } from "vitest";
import {
  CommandRequestSchema,
  CommandResponseSchema,
  ControlledCommandTypeSchema,
  DemoStateSchema,
  DemoUpdateRequestSchema,
  LockActionResponseSchema,
  LockRequestSchema,
  LockStateSchema,
  RobotListResponseSchema,
} from "../src/index";

const COMMAND_ID = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";
const CORRELATION_ID = "corr-0001-abcd";
const TS = "2026-11-02T10:00:00.000Z";
const SUB = "3f1c2b4a-1111-2222-3333-444455556666";
const ROBOT_SUMMARY = {
  robotId: "sim-01",
  siteId: "paris-01",
  name: "Simulated 01",
  type: "AMR",
  designDate: "2026-01-15",
  simulated: true,
  status: "ACTIVE",
  createdAt: TS,
};
const LOCK_FREE = { robotId: "kali-01", held: false, mine: false };
const LOCK_HELD = { robotId: "kali-01", held: true, holder: SUB, mine: true, expiresAt: TS };

/** Copies an object without one key, so that a test can omit a required field. */
function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

describe("CommandRequestSchema", () => {
  it.each([
    ["PAUSE", { type: "PAUSE" }],
    ["RESUME", { type: "RESUME" }],
    ["RETURN_TO_BASE", { type: "RETURN_TO_BASE" }],
    ["ESTOP", { type: "ESTOP" }],
    ["ESTOP_RELEASE", { type: "ESTOP_RELEASE" }],
    ["SIMULATE_FAULT", { type: "SIMULATE_FAULT", params: { fault: "LINK_LOSS" } }],
    [
      "SIMULATE_FAULT with a duration",
      { type: "SIMULATE_FAULT", params: { fault: "OBSTACLE", durationS: 30 } },
    ],
  ])("accepts %s", (_label, body) => {
    expect(CommandRequestSchema.safeParse({ commandId: COMMAND_ID, ...body }).success).toBe(true);
  });

  it.each([
    ["PAUSE with a parameter", { type: "PAUSE", params: { x: 1 } }],
    ["SIMULATE_FAULT without a fault", { type: "SIMULATE_FAULT", params: {} }],
    [
      "SIMULATE_FAULT with a duration of zero",
      { type: "SIMULATE_FAULT", params: { fault: "LINK_LOSS", durationS: 0 } },
    ],
    ["TAKE_CONTROL, which uses the lock route", { type: "TAKE_CONTROL" }],
    ["RELEASE_CONTROL, which uses the lock route", { type: "RELEASE_CONTROL" }],
    ["HEARTBEAT, which uses the WebSocket", { type: "HEARTBEAT" }],
    [
      "DRIVE, which the demo does not build",
      { type: "DRIVE", params: { linear: 0, angular: 0, durationMs: 100 } },
    ],
    ["an unknown type", { type: "REBOOT" }],
    ["an extra top-level key", { type: "PAUSE", lockToken: "abcdefghijklmnop" }],
  ])("refuses %s", (_label, body) => {
    expect(CommandRequestSchema.safeParse({ commandId: COMMAND_ID, ...body }).success).toBe(false);
  });

  it("refuses an uppercase command identifier", () => {
    expect(
      CommandRequestSchema.safeParse({ commandId: COMMAND_ID.toUpperCase(), type: "PAUSE" })
        .success,
    ).toBe(false);
  });

  it("refuses a command without an identifier", () => {
    expect(CommandRequestSchema.safeParse({ type: "PAUSE" }).success).toBe(false);
  });
});

describe("ControlledCommandTypeSchema", () => {
  it("lists the six commands of the route and no lock or socket command", () => {
    expect(ControlledCommandTypeSchema.options).toEqual([
      "PAUSE",
      "RESUME",
      "RETURN_TO_BASE",
      "ESTOP",
      "ESTOP_RELEASE",
      "SIMULATE_FAULT",
    ]);
  });
});

describe("CommandResponseSchema", () => {
  const response = {
    commandId: COMMAND_ID,
    correlationId: CORRELATION_ID,
    issuedAt: TS,
    deduplicated: false,
  };

  it("accepts an accepted command, and a deduplicated one", () => {
    expect(CommandResponseSchema.safeParse(response).success).toBe(true);
    expect(CommandResponseSchema.safeParse({ ...response, deduplicated: true }).success).toBe(true);
  });

  it("refuses a response without the deduplication flag", () => {
    expect(CommandResponseSchema.safeParse(withoutKey(response, "deduplicated")).success).toBe(
      false,
    );
  });
});

describe("LockRequestSchema", () => {
  it("accepts a command identifier and nothing else", () => {
    expect(LockRequestSchema.safeParse({ commandId: COMMAND_ID }).success).toBe(true);
    expect(
      LockRequestSchema.safeParse({ commandId: COMMAND_ID, lockToken: "abcdefghijklmnop" }).success,
    ).toBe(false);
  });
});

describe("LockStateSchema", () => {
  it("accepts a free lock and a lock held by the caller", () => {
    expect(LockStateSchema.safeParse(LOCK_FREE).success).toBe(true);
    expect(LockStateSchema.safeParse(LOCK_HELD).success).toBe(true);
  });

  it("refuses a held lock without a holder", () => {
    expect(LockStateSchema.safeParse(withoutKey(LOCK_HELD, "holder")).success).toBe(false);
  });

  it("refuses a free lock that names a holder", () => {
    expect(LockStateSchema.safeParse({ ...LOCK_FREE, holder: SUB }).success).toBe(false);
  });

  it("refuses a lock that is mine while it is not held", () => {
    expect(LockStateSchema.safeParse({ ...LOCK_FREE, mine: true }).success).toBe(false);
  });

  it("refuses a state that carries the lock token, which never leaves the cloud", () => {
    expect(
      LockStateSchema.safeParse({ ...LOCK_HELD, lockToken: "abcdefghijklmnopqrstu" }).success,
    ).toBe(false);
  });
});

describe("LockActionResponseSchema", () => {
  it("accepts the answer to an acquire and refuses a token inside it", () => {
    const answer = {
      commandId: COMMAND_ID,
      correlationId: CORRELATION_ID,
      changed: true,
      lock: LOCK_HELD,
    };
    expect(LockActionResponseSchema.safeParse(answer).success).toBe(true);
    expect(
      LockActionResponseSchema.safeParse({
        ...answer,
        lock: { ...LOCK_HELD, lockToken: "abcdefghijklmnop" },
      }).success,
    ).toBe(false);
  });
});

describe("RobotListResponseSchema", () => {
  it("accepts an empty site and a list of summaries", () => {
    expect(RobotListResponseSchema.safeParse({ robots: [] }).success).toBe(true);
    expect(RobotListResponseSchema.safeParse({ robots: [ROBOT_SUMMARY] }).success).toBe(true);
  });

  it("refuses a robot that carries key or certificate material", () => {
    expect(
      RobotListResponseSchema.safeParse({
        robots: [{ ...ROBOT_SUMMARY, certificateArn: "arn:aws:iot:eu-west-3:0:cert/x" }],
      }).success,
    ).toBe(false);
  });

  it("refuses a list longer than 100 robots", () => {
    const robots = Array.from({ length: 101 }, () => ROBOT_SUMMARY);
    expect(RobotListResponseSchema.safeParse({ robots }).success).toBe(false);
  });
});

describe("demo mode schemas", () => {
  it("accepts a demo state that was never changed, and one that was", () => {
    expect(DemoStateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      DemoStateSchema.safeParse({ enabled: true, changedBy: SUB, changedAt: TS }).success,
    ).toBe(true);
  });

  it("refuses a demo state whose changer is not a user subject", () => {
    expect(DemoStateSchema.safeParse({ enabled: true, changedBy: "a b" }).success).toBe(false);
  });

  it("accepts a boolean update and refuses anything else", () => {
    expect(DemoUpdateRequestSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(DemoUpdateRequestSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(DemoUpdateRequestSchema.safeParse({ enabled: true, changedBy: SUB }).success).toBe(
      false,
    );
  });
});
