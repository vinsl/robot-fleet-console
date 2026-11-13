/**
 * UUIDv7 generator: layout bits, timestamp placement, ordering, and argument checks.
 */
import { describe, expect, it } from "vitest";
import { Uuidv7Schema, uuidv7 } from "../src/index";

/** Random source that returns the same byte everywhere, so the layout can be read back exactly. */
function fixedRandom(byte: number): (count: number) => Uint8Array {
  return (count) => new Uint8Array(count).fill(byte);
}

describe("uuidv7", () => {
  it("sets the version nibble to 7 and the variant bits to 10", () => {
    const id = uuidv7(1_700_000_000_000, fixedRandom(0xff));
    expect(id.charAt(14)).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
  });

  it("places the 48-bit millisecond timestamp in the first twelve hex digits", () => {
    // 0x0189_4a2b_c123 is a fixed instant; its hex form must be the leading group of the identifier.
    const nowMs = 0x0189_4a2b_c123;
    const id = uuidv7(nowMs, fixedRandom(0x00));
    expect(id.replaceAll("-", "").slice(0, 12)).toBe(nowMs.toString(16).padStart(12, "0"));
  });

  it("keeps the random bits that the layout does not reserve", () => {
    const id = uuidv7(0, fixedRandom(0xff));
    // Only the version (4 bits) and the variant (2 bits) are fixed; everything else stays random.
    expect(id.replaceAll("-", "").slice(12, 16)).toBe("7fff");
    expect(id.replaceAll("-", "").slice(16, 20)).toBe("bfff");
  });

  it("sorts as strings in the order of the timestamps it was given", () => {
    const earlier = uuidv7(1_000, fixedRandom(0xff));
    const later = uuidv7(1_001, fixedRandom(0x00));
    expect(earlier < later).toBe(true);
  });

  it("produces identifiers that the protocol schema accepts", () => {
    expect(Uuidv7Schema.safeParse(uuidv7()).success).toBe(true);
  });

  it("uses fresh randomness on each call with the default source", () => {
    expect(uuidv7(5)).not.toBe(uuidv7(5));
  });

  it.each([-1, 1.5, 2 ** 48, Number.NaN])("refuses a timestamp of %s", (nowMs) => {
    expect(() => uuidv7(nowMs, fixedRandom(0))).toThrow(RangeError);
  });

  it("refuses a random source that returns the wrong number of bytes", () => {
    expect(() => uuidv7(1, () => new Uint8Array(9))).toThrow(RangeError);
  });

  it("accepts the largest representable timestamp", () => {
    expect(uuidv7(2 ** 48 - 1, fixedRandom(0)).slice(0, 13)).toBe("ffffffff-ffff");
  });
});

describe("Uuidv7Schema", () => {
  it("rejects a version 4 identifier", () => {
    expect(Uuidv7Schema.safeParse("3f2504e0-4f89-41d3-9a0c-0305e82c3301").success).toBe(false);
  });

  it("rejects a version 7 identifier with a reserved variant", () => {
    expect(Uuidv7Schema.safeParse("0190a7c4-5b1e-7d2a-0c3f-4e5d6a7b8c9d").success).toBe(false);
  });
});
