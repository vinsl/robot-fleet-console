/**
 * Audit records of the control actions: the contract of the protocol, and a failed write that never reaches the caller.
 */
import { describe, expect, it } from "vitest";
import { controlAuditRecord, writeControlAudit } from "../../../src/domain/control/audit";
import {
  CONTROL_ROBOT,
  CONTROL_SITE,
  OPERATOR_SUB,
  commandIdOf,
  controlWorld,
} from "../../fakes/control";

describe("control audit records", () => {
  it("names the robot for a lock action and the command identifier for a command action", () => {
    const world = controlWorld();
    const lock = controlAuditRecord(world.deps, {
      siteId: CONTROL_SITE,
      robotId: CONTROL_ROBOT,
      actor: OPERATOR_SUB,
      action: "lock.acquire",
      result: "SUCCEEDED",
      correlationId: "corr-00000001",
    });
    const command = controlAuditRecord(world.deps, {
      siteId: CONTROL_SITE,
      robotId: CONTROL_ROBOT,
      commandId: commandIdOf(1),
      actor: OPERATOR_SUB,
      action: "command.pause",
      result: "SUCCEEDED",
      correlationId: "corr-00000001",
    });

    expect(lock).toMatchObject({ robotId: CONTROL_ROBOT });
    expect(lock).not.toHaveProperty("commandId");
    expect(command).toMatchObject({ robotId: CONTROL_ROBOT, commandId: commandIdOf(1) });
  });

  it("throws when a command action has no command identifier: a programming error, caught by the writer", async () => {
    const world = controlWorld();
    expect(() =>
      controlAuditRecord(world.deps, {
        siteId: CONTROL_SITE,
        robotId: CONTROL_ROBOT,
        actor: OPERATOR_SUB,
        action: "command.pause",
        result: "SUCCEEDED",
        correlationId: "corr-00000001",
      }),
    ).toThrow();
    await writeControlAudit(world.deps, {
      siteId: CONTROL_SITE,
      robotId: CONTROL_ROBOT,
      actor: OPERATOR_SUB,
      action: "command.pause",
      result: "SUCCEEDED",
      correlationId: "corr-00000001",
    });
    expect(world.metrics.value("AuditWriteFailed")).toBe(1);
    expect(world.audit.records).toEqual([]);
  });
});
