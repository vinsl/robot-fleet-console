import { describe, expect, it } from "vitest";
import { buildHealthReport } from "../../src/domain/health";

describe("buildHealthReport", () => {
  it("returns exactly status, version and the millisecond ISO timestamp", () => {
    const report = buildHealthReport({
      version: "0.0.0",
      now: new Date("2026-10-31T10:00:00.123Z"),
    });
    expect(report).toStrictEqual({
      status: "ok",
      version: "0.0.0",
      time: "2026-10-31T10:00:00.123Z",
    });
  });

  it("rejects an empty version against the shared contract", () => {
    expect(() => buildHealthReport({ version: "", now: new Date(0) })).toThrow(/"version"/);
  });

  it("rejects a version longer than 64 characters against the shared contract", () => {
    expect(() => buildHealthReport({ version: "v".repeat(65), now: new Date(0) })).toThrow(
      /"version"/,
    );
  });

  it("rejects an invalid date instead of emitting a bad timestamp", () => {
    expect(() => buildHealthReport({ version: "0.0.0", now: new Date(NaN) })).toThrow(RangeError);
  });

  it("rejects a date outside the four-digit year range", () => {
    // toISOString switches to an expanded "+275760-..." form that the datetime contract refuses.
    expect(() => buildHealthReport({ version: "0.0.0", now: new Date(8.64e15) })).toThrow(/"time"/);
  });
});
