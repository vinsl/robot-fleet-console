import { describe, expect, it } from "vitest";
import { AuditRecordSchema } from "@mfc/protocol";
import { alertAuditRecord, writeAlertAudit } from "../../../src/domain/alerts/audit";
import { ALERT_ID, alertsWorld, CALL, ROBOT_ID, SITE_ID, START_TIME } from "../../fakes/alerts";

const INPUT = {
  siteId: SITE_ID,
  robotId: ROBOT_ID,
  alertId: ALERT_ID,
  actor: CALL.actor,
  action: "alert.resolve",
  correlationId: CALL.correlationId,
} as const;

describe("alertAuditRecord", () => {
  it("builds a protocol-valid record stamped with the given instant and the identifier source", () => {
    const { deps } = alertsWorld();

    const record = alertAuditRecord(deps, {
      ...INPUT,
      at: START_TIME.toISOString(),
      result: "SUCCEEDED",
    });

    expect(AuditRecordSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      ts: START_TIME.toISOString(),
      actorSource: "mfc.jwt",
      robotId: ROBOT_ID,
      alertId: ALERT_ID,
      result: "SUCCEEDED",
    });
    expect(record).not.toHaveProperty("problemType");
  });

  it("refuses a record whose robot identifier breaks the protocol contract", () => {
    const { deps } = alertsWorld();
    expect(() =>
      alertAuditRecord(deps, {
        ...INPUT,
        at: START_TIME.toISOString(),
        robotId: "Not A Robot",
        result: "SUCCEEDED",
      }),
    ).toThrow();
  });
});

describe("writeAlertAudit", () => {
  it("writes the REFUSED record with its problem type", async () => {
    const world = alertsWorld();

    await writeAlertAudit(world.deps, {
      ...INPUT,
      result: "REFUSED",
      problemType: "alert-state-conflict",
    });

    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      result: "REFUSED",
      problemType: "alert-state-conflict",
    });
  });

  it("never throws when the write fails, and counts the failure", async () => {
    const world = alertsWorld();
    world.audit.failure = new Error("access denied for the audit table");

    await expect(
      writeAlertAudit(world.deps, {
        ...INPUT,
        result: "REFUSED",
        problemType: "alert-state-conflict",
      }),
    ).resolves.toBeUndefined();

    expect(world.metrics.value("AuditWriteFailed")).toBe(1);
    expect(world.logger.text()).not.toContain("access denied");
  });
});
