/**
 * Alert records: the severity table, the all-or-none pairs of acknowledgement and resolution, and the
 * status that must agree with the fields present.
 */
import { describe, expect, it } from "vitest";
import {
  ALERT_RETENTION_SECONDS,
  ALERT_SEVERITY_BY_KIND,
  AlertKindSchema,
  AlertRecordSchema,
  MISSION_RECORD_RETENTION_SECONDS,
  STATE_RECORD_RETENTION_SECONDS,
  type AlertRecord,
} from "../src/index";

const OPENED_AT = "2026-11-02T10:00:00.000Z";
const ACKNOWLEDGED_AT = "2026-11-02T10:01:00.000Z";
const RESOLVED_AT = "2026-11-02T10:05:00.000Z";
const OPERATOR = "3f1c2b4a-1111-2222-3333-444455556666";

const OPEN_BLOCKED: AlertRecord = {
  alertId: "0123456789abcdef0123456789abcdef",
  siteId: "paris-01",
  robotId: "kali-01",
  kind: "BLOCKED",
  severity: "MAJOR",
  status: "OPEN",
  openedAt: OPENED_AT,
  cause: "FAULT_OBSTACLE",
  sourceMessageId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
};

/**
 * Builds a copy of an alert with some fields replaced.
 *
 * @param change - The fields to set, merged over the base alert.
 * @returns The changed alert, as an input of unknown shape for the schema.
 */
function alert(change: Readonly<Record<string, unknown>>): unknown {
  return { ...OPEN_BLOCKED, ...change };
}

describe("ALERT_SEVERITY_BY_KIND", () => {
  it("maps every kind to the severity the design fixes", () => {
    expect(ALERT_SEVERITY_BY_KIND).toEqual({
      ESTOP: "CRITICAL",
      BLOCKED: "MAJOR",
      OFFLINE: "MAJOR",
      LOW_BATTERY: "MINOR",
    });
  });

  it("covers exactly the kinds the schema accepts", () => {
    expect(Object.keys(ALERT_SEVERITY_BY_KIND).sort()).toEqual([...AlertKindSchema.options].sort());
  });
});

describe("AlertRecordSchema", () => {
  it("accepts an open alert", () => {
    expect(AlertRecordSchema.safeParse(OPEN_BLOCKED).success).toBe(true);
  });

  it("accepts an acknowledged alert", () => {
    const acknowledged = alert({
      status: "ACKNOWLEDGED",
      acknowledgedBy: OPERATOR,
      acknowledgedAt: ACKNOWLEDGED_AT,
    });
    expect(AlertRecordSchema.safeParse(acknowledged).success).toBe(true);
  });

  it("accepts a resolved alert, with or without a prior acknowledgement", () => {
    const resolvedDirectly = alert({
      status: "RESOLVED",
      resolvedBy: "robot",
      resolvedAt: RESOLVED_AT,
    });
    const acknowledgedThenResolved = alert({
      status: "RESOLVED",
      acknowledgedBy: OPERATOR,
      acknowledgedAt: ACKNOWLEDGED_AT,
      resolvedBy: OPERATOR,
      resolvedAt: RESOLVED_AT,
    });
    expect(AlertRecordSchema.safeParse(resolvedDirectly).success).toBe(true);
    expect(AlertRecordSchema.safeParse(acknowledgedThenResolved).success).toBe(true);
  });

  it.each(Object.entries(ALERT_SEVERITY_BY_KIND))(
    "accepts %s with its own severity",
    (kind, severity) => {
      expect(AlertRecordSchema.safeParse(alert({ kind, severity })).success).toBe(true);
    },
  );

  it("refuses an unknown kind, such as the late mission the protocol does not report", () => {
    expect(AlertRecordSchema.safeParse(alert({ kind: "LATE_MISSION" })).success).toBe(false);
  });

  it("refuses an acknowledgement with no time", () => {
    expect(AlertRecordSchema.safeParse(alert({ acknowledgedBy: OPERATOR })).success).toBe(false);
  });

  it("refuses an acknowledgement with no operator", () => {
    expect(AlertRecordSchema.safeParse(alert({ acknowledgedAt: ACKNOWLEDGED_AT })).success).toBe(
      false,
    );
  });

  it("refuses a resolution with no time", () => {
    expect(
      AlertRecordSchema.safeParse(alert({ status: "RESOLVED", resolvedBy: "robot" })).success,
    ).toBe(false);
  });

  it("refuses an OPEN alert with a resolution, as the design names", () => {
    expect(
      AlertRecordSchema.safeParse(alert({ resolvedBy: "robot", resolvedAt: RESOLVED_AT })).success,
    ).toBe(false);
  });

  it("refuses an OPEN alert with an acknowledgement", () => {
    expect(
      AlertRecordSchema.safeParse(
        alert({ acknowledgedBy: OPERATOR, acknowledgedAt: ACKNOWLEDGED_AT }),
      ).success,
    ).toBe(false);
  });

  it("refuses an ACKNOWLEDGED alert without an acknowledgement", () => {
    expect(AlertRecordSchema.safeParse(alert({ status: "ACKNOWLEDGED" })).success).toBe(false);
  });

  it("refuses an ACKNOWLEDGED alert that already carries a resolution", () => {
    expect(
      AlertRecordSchema.safeParse(
        alert({
          status: "ACKNOWLEDGED",
          acknowledgedBy: OPERATOR,
          acknowledgedAt: ACKNOWLEDGED_AT,
          resolvedBy: "robot",
          resolvedAt: RESOLVED_AT,
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses a RESOLVED alert without a resolution", () => {
    expect(AlertRecordSchema.safeParse(alert({ status: "RESOLVED" })).success).toBe(false);
  });

  it.each([
    ["an identifier in upper case", "0123456789ABCDEF0123456789ABCDEF"],
    ["a short identifier", "0123456789abcdef"],
    ["an identifier that is not hexadecimal", "0123456789abcdef0123456789abcdeg"],
  ])("refuses %s", (_label, alertId) => {
    expect(AlertRecordSchema.safeParse(alert({ alertId })).success).toBe(false);
  });

  it("refuses a cause that is free text", () => {
    expect(
      AlertRecordSchema.safeParse(alert({ cause: "the robot is stuck near dock A" })).success,
    ).toBe(false);
  });

  it("refuses a source message identifier that is not a UUIDv7", () => {
    expect(AlertRecordSchema.safeParse(alert({ sourceMessageId: "not-a-uuid" })).success).toBe(
      false,
    );
  });

  it("refuses an operator name that is not a user subject", () => {
    expect(
      AlertRecordSchema.safeParse(
        alert({
          status: "ACKNOWLEDGED",
          acknowledgedBy: "ops@example.com",
          acknowledgedAt: ACKNOWLEDGED_AT,
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses an extra key", () => {
    expect(AlertRecordSchema.safeParse(alert({ email: "ops@example.com" })).success).toBe(false);
  });

  it("refuses an unknown status", () => {
    expect(AlertRecordSchema.safeParse(alert({ status: "CLOSED" })).success).toBe(false);
  });

  it("refuses an acknowledgement dated before the alert was opened", () => {
    const acknowledgedEarly = alert({
      status: "ACKNOWLEDGED",
      acknowledgedBy: OPERATOR,
      acknowledgedAt: "2026-11-02T09:59:59.999Z",
    });
    expect(AlertRecordSchema.safeParse(acknowledgedEarly).success).toBe(false);
  });

  it("refuses a resolution dated before the alert was opened", () => {
    const resolvedEarly = alert({
      status: "RESOLVED",
      resolvedBy: "robot",
      resolvedAt: "2026-11-02T09:59:59.999Z",
    });
    expect(AlertRecordSchema.safeParse(resolvedEarly).success).toBe(false);
  });

  it("accepts an acknowledgement and a resolution at the very instant the alert opened", () => {
    const sameInstant = alert({
      status: "RESOLVED",
      acknowledgedBy: OPERATOR,
      acknowledgedAt: OPENED_AT,
      resolvedBy: "robot",
      resolvedAt: OPENED_AT,
    });
    expect(AlertRecordSchema.safeParse(sameInstant).success).toBe(true);
  });
});

describe("retention", () => {
  it("keeps alerts 90 days, live state changes 7 days and missions 30 days", () => {
    expect(ALERT_RETENTION_SECONDS).toBe(90 * 86_400);
    expect(STATE_RECORD_RETENTION_SECONDS).toBe(7 * 86_400);
    expect(MISSION_RECORD_RETENTION_SECONDS).toBe(30 * 86_400);
  });

  it("keeps every retention a positive whole number of seconds", () => {
    for (const seconds of [
      ALERT_RETENTION_SECONDS,
      STATE_RECORD_RETENTION_SECONDS,
      MISSION_RECORD_RETENTION_SECONDS,
    ]) {
      expect(Number.isSafeInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
    }
  });

  it("keeps alerts longer than missions and live state changes, for the audit trail", () => {
    expect(ALERT_RETENTION_SECONDS).toBeGreaterThan(MISSION_RECORD_RETENTION_SECONDS);
    expect(MISSION_RECORD_RETENTION_SECONDS).toBeGreaterThan(STATE_RECORD_RETENTION_SECONDS);
  });
});
