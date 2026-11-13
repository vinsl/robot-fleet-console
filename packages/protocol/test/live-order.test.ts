/**
 * Ordering of live robot samples: the rule shared by the API and the console.
 */
import { describe, expect, it } from "vitest";
import { isNewerSample } from "../src/index";

const BOOT_A = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";
const BOOT_B = "0190a7c5-0000-7000-8000-000000000000";

describe("isNewerSample", () => {
  it("accepts any sample when none is held", () => {
    expect(isNewerSample(undefined, { bootId: BOOT_A, seq: 0 })).toBe(true);
  });

  it("accepts a sample of a greater boot whatever its sequence", () => {
    expect(isNewerSample({ bootId: BOOT_A, seq: 900 }, { bootId: BOOT_B, seq: 1 })).toBe(true);
  });

  it("refuses a sample of a lower boot whatever its sequence", () => {
    expect(isNewerSample({ bootId: BOOT_B, seq: 1 }, { bootId: BOOT_A, seq: 900 })).toBe(false);
  });

  it("accepts a greater sequence within the same boot", () => {
    expect(isNewerSample({ bootId: BOOT_A, seq: 4 }, { bootId: BOOT_A, seq: 5 })).toBe(true);
  });

  it("refuses an equal key, so a duplicate frame is not applied twice", () => {
    expect(isNewerSample({ bootId: BOOT_A, seq: 4 }, { bootId: BOOT_A, seq: 4 })).toBe(false);
  });

  it("refuses a lower sequence within the same boot", () => {
    expect(isNewerSample({ bootId: BOOT_A, seq: 5 }, { bootId: BOOT_A, seq: 4 })).toBe(false);
  });
});
