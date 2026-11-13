/**
 * Audit writes: a well-formed record reaches the port, and a failing write is swallowed, logged and counted.
 */
import { AuditRecordSchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { recordAudit, type AuditInput } from "../../../src/domain/robots/audit";
import { awsError } from "../../fakes/call-gate";
import { createWorld, START_TIME, TEST_ACTOR, TEST_CORRELATION_ID } from "../../fakes/world";

/** The facts of a successful registration, the common case. */
const SUCCESS: AuditInput = {
  siteId: "paris-01",
  robotId: "kali-01",
  actor: TEST_ACTOR,
  action: "robots.register",
  result: "SUCCEEDED",
  correlationId: TEST_CORRELATION_ID,
};

describe("recordAudit", () => {
  it("writes a valid record stamped with the clock and a fresh identifier", async () => {
    const world = createWorld();
    await recordAudit(world.deps, SUCCESS);

    expect(world.audit.records).toHaveLength(1);
    const [record] = world.audit.records;
    expect(AuditRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      ts: START_TIME.toISOString(),
      actorSource: "mfc.admin",
      action: "robots.register",
      result: "SUCCEEDED",
    });
    expect(record).not.toHaveProperty("problemType");
  });

  it("carries the problem type of a refusal", async () => {
    const world = createWorld();
    await recordAudit(world.deps, { ...SUCCESS, result: "REFUSED", problemType: "robot-exists" });
    expect(world.audit.records[0]).toHaveProperty("problemType", "robot-exists");
  });

  it("swallows a failing write, logs its error name and counts the failure", async () => {
    const world = createWorld();
    world.audit.gate.fail("write", awsError("InternalFailure"));

    await expect(recordAudit(world.deps, SUCCESS)).resolves.toBeUndefined();

    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "audit write failed",
        attributes: expect.objectContaining({ errorName: "InternalFailure" }) as unknown,
      }),
    );
    expect(world.audit.records).toHaveLength(0);
  });

  it("refuses to write an inconsistent record and counts it as a failed write", async () => {
    const world = createWorld();
    // A success carries no problem type: a problem type here is a caller bug the schema must catch.
    await recordAudit(world.deps, { ...SUCCESS, problemType: "internal" });

    expect(world.audit.records).toHaveLength(0);
    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
  });
});
