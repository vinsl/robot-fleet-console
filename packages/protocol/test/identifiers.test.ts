/**
 * Identifier, thing name, time and envelope schemas beyond the basic robot and site identifiers.
 */
import { describe, expect, it } from "vitest";
import {
  CorrelationIdSchema,
  IsoDateSchema,
  IsoMsSchema,
  LockTokenSchema,
  MissionIdSchema,
  SchemaVersionSchema,
  ThingNameSchema,
  UserSubSchema,
  robotIdFromThingName,
  thingName,
} from "../src/index";

describe("ThingNameSchema", () => {
  it.each(["mfc-demo-kali-01", "mfc-demo-sim-20", "mfc-demo-abc"])("accepts %s", (value) => {
    expect(ThingNameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["without the prefix", "kali-01"],
    ["uppercase prefix", "MFC-DEMO-kali-01"],
    ["robot part too short", "mfc-demo-ab"],
    ["robot part too long", `mfc-demo-${"a".repeat(33)}`],
    ["underscore in the robot part", "mfc-demo-kali_01"],
  ])("rejects a name %s", (_label, value) => {
    expect(ThingNameSchema.safeParse(value).success).toBe(false);
  });
});

describe("thingName and robotIdFromThingName", () => {
  it("builds the thing name of a robot", () => {
    expect(thingName("kali-01")).toBe("mfc-demo-kali-01");
  });

  it("refuses to build a thing name from an invalid robot identifier", () => {
    expect(() => thingName("Kali/01")).toThrow(TypeError);
  });

  it("recovers the robot identifier from a thing name", () => {
    expect(robotIdFromThingName("mfc-demo-kali-01")).toBe("kali-01");
  });

  it.each(["kali-01", "mfc-demo-", "mfc-demo-Kali-01", `mfc-demo-${"a".repeat(33)}`])(
    "returns null for a name that is not a thing name: %s",
    (name) => {
      expect(robotIdFromThingName(name)).toBeNull();
    },
  );
});

describe("LockTokenSchema", () => {
  it("accepts a token of 16 characters and one of 128", () => {
    expect(LockTokenSchema.safeParse("a".repeat(16)).success).toBe(true);
    expect(LockTokenSchema.safeParse("a".repeat(128)).success).toBe(true);
  });

  it("rejects a token of 15 or 129 characters, and any token outside the alphabet", () => {
    expect(LockTokenSchema.safeParse("a".repeat(15)).success).toBe(false);
    expect(LockTokenSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(LockTokenSchema.safeParse(`${"a".repeat(15)}+`).success).toBe(false);
  });
});

describe("UserSubSchema", () => {
  it("accepts a Cognito-style subject and rejects an empty or spaced one", () => {
    expect(UserSubSchema.safeParse("7f3e2a10-9b4c-4d5e-8f60-1a2b3c4d5e6f").success).toBe(true);
    expect(UserSubSchema.safeParse("").success).toBe(false);
    expect(UserSubSchema.safeParse("user name").success).toBe(false);
  });
});

describe("CorrelationIdSchema", () => {
  it("accepts 8 and 64 characters and refuses 7 and 65", () => {
    expect(CorrelationIdSchema.safeParse("a".repeat(8)).success).toBe(true);
    expect(CorrelationIdSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(CorrelationIdSchema.safeParse("a".repeat(7)).success).toBe(false);
    expect(CorrelationIdSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("MissionIdSchema", () => {
  it("accepts a lowercase slug and refuses uppercase letters", () => {
    expect(MissionIdSchema.safeParse("mission-0042").success).toBe(true);
    expect(MissionIdSchema.safeParse("Mission-1").success).toBe(false);
  });
});

describe("IsoMsSchema", () => {
  it("accepts UTC with millisecond precision and the Z suffix", () => {
    expect(IsoMsSchema.safeParse("2026-11-01T10:00:00.000Z").success).toBe(true);
  });

  it.each([
    ["a numeric offset", "2026-11-01T10:00:00.000+00:00"],
    ["no milliseconds", "2026-11-01T10:00:00Z"],
    ["microseconds", "2026-11-01T10:00:00.000000Z"],
    ["no timezone", "2026-11-01T10:00:00.000"],
  ])("rejects %s", (_label, value) => {
    expect(IsoMsSchema.safeParse(value).success).toBe(false);
  });
});

describe("IsoDateSchema", () => {
  it("accepts a calendar date and refuses an impossible one", () => {
    expect(IsoDateSchema.safeParse("2026-10-30").success).toBe(true);
    expect(IsoDateSchema.safeParse("2026-02-30").success).toBe(false);
  });
});

describe("SchemaVersionSchema", () => {
  it("accepts every minor and patch of major 1", () => {
    expect(SchemaVersionSchema.safeParse("1.0.0").success).toBe(true);
    expect(SchemaVersionSchema.safeParse("1.12.3").success).toBe(true);
  });

  it.each(["2.0.0", "1.0", "v1.0.0", "1.0.0-beta"])("refuses %s", (value) => {
    expect(SchemaVersionSchema.safeParse(value).success).toBe(false);
  });
});
