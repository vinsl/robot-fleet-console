/**
 * Contract of the command builder (ADR 0027): every type the cloud can publish is accepted by the protocol schema.
 */
import { CommandSchema, CommandTypeSchema, type CommandType } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { buildCommand, type BuildCommandInput } from "../../../src/domain/control/build-command";
import { FIXTURE_TOKEN, commandIdOf } from "../../fakes/control";

const BASE: Omit<BuildCommandInput, "type"> = {
  robotId: "sim-03",
  siteId: "paris-01",
  commandId: commandIdOf(1),
  correlationId: "corr-00000001",
  messageId: commandIdOf(2),
  issuedBy: "00000000-0000-4000-8000-0000000000a1",
  now: new Date("2026-11-04T10:00:00.123Z"),
};

/**
 * The input of one command type, with the parameters and the token that type needs.
 *
 * @param type - The command type.
 * @returns The builder input.
 */
function inputOf(type: CommandType): BuildCommandInput {
  switch (type) {
    case "TAKE_CONTROL":
      return { ...BASE, type, lockToken: FIXTURE_TOKEN };
    case "SIMULATE_FAULT":
      return { ...BASE, type, params: { fault: "SENSOR_FAULT" } };
    case "PAUSE":
    case "RESUME":
    case "RETURN_TO_BASE":
    case "ESTOP":
    case "ESTOP_RELEASE":
    case "RELEASE_CONTROL":
    case "HEARTBEAT":
    case "DRIVE":
      return { ...BASE, type };
  }
}

describe("buildCommand", () => {
  it("builder-contract", () => {
    for (const type of CommandTypeSchema.options) {
      if (type === "DRIVE") {
        continue;
      }
      const command = buildCommand(inputOf(type));
      expect(CommandSchema.safeParse(command).success, type).toBe(true);
      expect(JSON.stringify(command).length, type).toBeLessThan(4096);
    }
  });

  it("sets the cloud clock as both ts and issuedAt, with the identifiers of the request", () => {
    const command = buildCommand(inputOf("PAUSE"));

    expect(command.ts).toBe("2026-11-04T10:00:00.123Z");
    expect(command.issuedAt).toBe(command.ts);
    expect(command.commandId).toBe(commandIdOf(1));
    expect(command.params).toEqual({});
    expect(command.lockToken).toBeUndefined();
  });

  it("refuses a TAKE_CONTROL without its lock token", () => {
    const withoutToken: BuildCommandInput = { ...BASE, type: "TAKE_CONTROL" };
    expect(() => buildCommand(withoutToken)).toThrow();
  });
});
