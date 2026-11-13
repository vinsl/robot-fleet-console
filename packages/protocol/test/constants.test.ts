/**
 * Invariants between protocol constants. A change that breaks one of them breaks replay protection or
 * the scope of the IoT rules, so these tests fail before such a change reaches the robot.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_MAX_AGE_MS,
  REPLAY_LRU_SIZE,
  RULE_NAMES,
  SCHEMA_MAJOR,
  SCHEMA_VERSION,
  SchemaVersionSchema,
} from "../src/index";

/**
 * Publish rate per IoT connection, in messages per second (the AWS IoT Core quota for the message
 * broker). It bounds how many command identifiers can arrive inside the replay window.
 */
const IOT_PUBLISH_LIMIT_PER_S = 100;

describe("replay window", () => {
  it("keeps enough identifiers to cover the whole command age window at the broker rate", () => {
    // The design's invariant, strict: the LRU covers the window with room to spare, so an identifier
    // cannot be evicted while a replay of it is still accepted. 10 > 2 today.
    expect(REPLAY_LRU_SIZE / IOT_PUBLISH_LIMIT_PER_S).toBeGreaterThan(COMMAND_MAX_AGE_MS / 1000);
  });
});

describe("schema version", () => {
  it("is accepted by the envelope version schema", () => {
    expect(SchemaVersionSchema.safeParse(SCHEMA_VERSION).success).toBe(true);
  });

  it("has a major that equals SCHEMA_MAJOR", () => {
    expect(SCHEMA_VERSION.split(".")[0]).toBe(String(SCHEMA_MAJOR));
  });

  it("refuses the next major", () => {
    expect(SchemaVersionSchema.safeParse(`${String(SCHEMA_MAJOR + 1)}.0.0`).success).toBe(false);
  });
});

describe("IoT rule names", () => {
  it("are all inside the mfc_demo_ prefix that the CI role may manage", () => {
    for (const name of Object.values(RULE_NAMES)) {
      expect(name.startsWith("mfc_demo_")).toBe(true);
    }
  });
});
