/**
 * HTTP contract of the alerts API: the list query grammar, the cursor, the action body and the ordering of
 * an alert list. Every refusal here is a 400 at the API boundary, so each one is pinned.
 */
import { describe, expect, it } from "vitest";
import {
  ALERT_LIST_DEFAULT_LIMIT,
  ALERT_LIST_MAX_LIMIT,
  AlertActionRequestSchema,
  AlertListQuerySchema,
  compareAlerts,
  type AlertRecord,
} from "../src/index";

const CURSOR = "eyJzayI6IngifQ";

/**
 * Builds an OPEN alert with the fields the ordering reads; everything else is fixed. INFO has no kind of its
 * own, so its record is a fixture for the ordering only and is never a valid record.
 */
function alert(alertId: string, severity: AlertRecord["severity"], openedAt: string): AlertRecord {
  const kind = severity === "CRITICAL" ? "ESTOP" : severity === "MAJOR" ? "BLOCKED" : "LOW_BATTERY";
  return {
    alertId,
    siteId: "paris-01",
    robotId: "sim-01",
    kind,
    severity,
    status: "OPEN",
    openedAt,
  };
}

describe("AlertListQuerySchema", () => {
  it("defaults to the active list of the default page size", () => {
    const parsed = AlertListQuerySchema.parse({});
    expect(parsed.status).toBe("active");
    expect(parsed.limit).toBe(ALERT_LIST_DEFAULT_LIMIT);
    expect(parsed.limit).toBe(50);
  });

  it("refuses a limit above the maximum, zero and a non-number", () => {
    expect(AlertListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ limit: "20.5" }).success).toBe(false);
  });

  it("accepts a limit at the bounds and reads a numeric string", () => {
    expect(AlertListQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(AlertListQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(AlertListQuerySchema.parse({ limit: String(ALERT_LIST_MAX_LIMIT) }).limit).toBe(100);
  });

  it("refuses since on the active list and accepts it on the resolved list", () => {
    const since = "2026-11-02T10:00:00.000Z";
    expect(AlertListQuerySchema.safeParse({ status: "active", since }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ since }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ status: "resolved", since }).success).toBe(true);
  });

  it("refuses an unknown parameter", () => {
    expect(AlertListQuerySchema.safeParse({ foo: "bar" }).success).toBe(false);
  });

  it("refuses a severity list, which API Gateway builds from repeated parameters", () => {
    expect(AlertListQuerySchema.safeParse({ severity: "MAJOR,MINOR" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ severity: "MAJOR" }).success).toBe(true);
  });

  it("refuses a cursor that is not base64url of bounded length", () => {
    expect(AlertListQuerySchema.safeParse({ cursor: "ab+cd" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ cursor: "ab/cd" }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
    expect(AlertListQuerySchema.safeParse({ cursor: "a".repeat(512) }).success).toBe(true);
    expect(AlertListQuerySchema.parse({ cursor: CURSOR }).cursor).toBe(CURSOR);
  });
});

describe("AlertActionRequestSchema", () => {
  it("accepts the opening time alone", () => {
    expect(
      AlertActionRequestSchema.safeParse({ openedAt: "2026-11-02T10:00:00.000Z" }).success,
    ).toBe(true);
  });

  it("refuses any extra field, so the client cannot set the status, the actor or the time", () => {
    expect(
      AlertActionRequestSchema.safeParse({
        openedAt: "2026-11-02T10:00:00.000Z",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      AlertActionRequestSchema.safeParse({
        openedAt: "2026-11-02T10:00:00.000Z",
        status: "RESOLVED",
      }).success,
    ).toBe(false);
  });
});

describe("compareAlerts", () => {
  it("orders by severity, most urgent first", () => {
    const sorted = [
      alert("0".repeat(32), "INFO", "2026-11-02T10:00:00.000Z"),
      alert("1".repeat(32), "MINOR", "2026-11-02T10:00:00.000Z"),
      alert("2".repeat(32), "MAJOR", "2026-11-02T10:00:00.000Z"),
      alert("3".repeat(32), "CRITICAL", "2026-11-02T10:00:00.000Z"),
    ].sort(compareAlerts);
    expect(sorted.map((a) => a.severity)).toEqual(["CRITICAL", "MAJOR", "MINOR", "INFO"]);
  });

  it("orders the same severity newest first", () => {
    const older = alert("a".repeat(32), "MAJOR", "2026-11-02T10:00:00.000Z");
    const newer = alert("b".repeat(32), "MAJOR", "2026-11-02T10:05:00.000Z");
    expect([older, newer].sort(compareAlerts)).toEqual([newer, older]);
  });

  it("breaks a tie on the same severity and opening time by alert id", () => {
    const first = alert("a".repeat(32), "MAJOR", "2026-11-02T10:00:00.000Z");
    const second = alert("b".repeat(32), "MAJOR", "2026-11-02T10:00:00.000Z");
    expect([second, first].sort(compareAlerts)).toEqual([first, second]);
    expect(compareAlerts(first, first)).toBe(0);
  });
});
