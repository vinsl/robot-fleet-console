import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "../src/index";

const valid = {
  status: "ok",
  version: "0.0.0",
  time: "2026-10-31T10:00:00.000Z",
};

describe("HealthResponseSchema", () => {
  it("accepts a well-formed response", () => {
    expect(HealthResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects unknown properties so that no field leaks silently", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, accountId: "123" }).success).toBe(false);
  });

  it("rejects any status other than ok", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, status: "degraded" }).success).toBe(false);
  });

  it("rejects a timestamp without milliseconds", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, time: "2026-10-31T10:00:00Z" }).success).toBe(
      false,
    );
  });

  it("rejects a timestamp without the Z suffix", () => {
    expect(
      HealthResponseSchema.safeParse({ ...valid, time: "2026-10-31T10:00:00.000" }).success,
    ).toBe(false);
  });

  it("rejects an empty version", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, version: "" }).success).toBe(false);
  });

  it("accepts a version of exactly 64 characters and rejects 65", () => {
    expect(HealthResponseSchema.safeParse({ ...valid, version: "v".repeat(64) }).success).toBe(
      true,
    );
    expect(HealthResponseSchema.safeParse({ ...valid, version: "v".repeat(65) }).success).toBe(
      false,
    );
  });
});
