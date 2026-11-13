/**
 * The command policy table, checked against the protocol's lock lists and the role matrix.
 */
import {
  ControlledCommandTypeSchema,
  LOCK_FREE_COMMANDS,
  LOCK_REQUIRED_COMMANDS,
} from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { COMMAND_POLICY } from "../../../src/domain/control/policy";

/** The table as entries, so every row is read without indexing it by a computed key. */
const ROWS: readonly (readonly [string, (typeof COMMAND_POLICY)[keyof typeof COMMAND_POLICY]])[] =
  Object.entries(COMMAND_POLICY);

describe("command policy", () => {
  it("policy-matches-protocol", () => {
    const lockRequired: readonly string[] = LOCK_REQUIRED_COMMANDS;
    const lockFree: readonly string[] = LOCK_FREE_COMMANDS;
    expect(ROWS.map(([type]) => type).sort()).toEqual(
      [...ControlledCommandTypeSchema.options].sort(),
    );
    for (const [type, policy] of ROWS) {
      expect(policy.needsLock, type).toBe(lockRequired.includes(type));
      if (!policy.needsLock) {
        expect(lockFree.includes(type), type).toBe(true);
      }
    }
    // E-stop and fault injection are the two lock-free controlled commands.
    expect(COMMAND_POLICY.ESTOP.needsLock).toBe(false);
    expect(COMMAND_POLICY.SIMULATE_FAULT.needsLock).toBe(false);
  });

  it("fault injection needs the Admin, the demo mode and a simulated robot", () => {
    expect(COMMAND_POLICY.SIMULATE_FAULT).toMatchObject({
      roles: ["Admin"],
      needsDemoMode: true,
      needsSimulated: true,
      auditAction: "command.simulate_fault",
    });
  });

  it("only the fault injection needs the demo mode or a simulated robot", () => {
    for (const [type, policy] of ROWS) {
      if (type !== "SIMULATE_FAULT") {
        expect(policy.needsDemoMode, type).toBe(false);
        expect(policy.needsSimulated, type).toBe(false);
      }
    }
  });

  it("the viewer is in no command row", () => {
    for (const [type, policy] of ROWS) {
      expect(policy.roles, type).not.toContain("Viewer");
    }
  });

  it("every controlled type has an audit action of the command family", () => {
    for (const [type, policy] of ROWS) {
      expect(policy.auditAction.startsWith("command."), type).toBe(true);
    }
  });
});
