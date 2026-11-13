/**
 * Alert identifiers and records: deterministic under redelivery, distinct per source, severity from the kind.
 */
import { describe, expect, it } from "vitest";
import { alertIdOf, openAlertRecord } from "../../../src/domain/live/alerts";

const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";

describe("alertIdOf", () => {
  it("is the same for the same robot, kind and source (a redelivery maps to the same alert)", () => {
    expect(alertIdOf("kali-01", "BLOCKED", MESSAGE)).toBe(alertIdOf("kali-01", "BLOCKED", MESSAGE));
  });

  it("is 32 lowercase hexadecimal characters", () => {
    expect(alertIdOf("kali-01", "ESTOP", MESSAGE)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs when the robot, the kind or the source differs", () => {
    const base = alertIdOf("kali-01", "BLOCKED", MESSAGE);
    expect(alertIdOf("sim-01", "BLOCKED", MESSAGE)).not.toBe(base);
    expect(alertIdOf("kali-01", "ESTOP", MESSAGE)).not.toBe(base);
    expect(alertIdOf("kali-01", "BLOCKED", "other")).not.toBe(base);
  });
});

describe("openAlertRecord", () => {
  it("builds an open alert whose severity follows the kind", () => {
    const alert = openAlertRecord({
      siteId: "paris-01",
      robotId: "kali-01",
      kind: "ESTOP",
      sourceKey: MESSAGE,
      sourceMessageId: MESSAGE,
      openedAt: "2026-11-02T10:00:00.000Z",
      cause: "OPERATOR_ESTOP",
    });

    expect(alert).toStrictEqual({
      alertId: alertIdOf("kali-01", "ESTOP", MESSAGE),
      siteId: "paris-01",
      robotId: "kali-01",
      kind: "ESTOP",
      severity: "CRITICAL",
      status: "OPEN",
      openedAt: "2026-11-02T10:00:00.000Z",
      cause: "OPERATOR_ESTOP",
      sourceMessageId: MESSAGE,
    });
  });

  it("gives a low battery alert the Minor severity", () => {
    const alert = openAlertRecord({
      siteId: "paris-01",
      robotId: "kali-01",
      kind: "LOW_BATTERY",
      sourceKey: MESSAGE,
      openedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(alert.severity).toBe("MINOR");
  });

  it("refuses a cause that is not a short token, since it is shown to operators", () => {
    expect(() =>
      openAlertRecord({
        siteId: "paris-01",
        robotId: "kali-01",
        kind: "BLOCKED",
        sourceKey: MESSAGE,
        openedAt: "2026-11-02T10:00:00.000Z",
        cause: "free text with spaces",
      }),
    ).toThrow();
  });
});
