/**
 * Text and visual keys of the command results.
 */
import { describe, expect, it } from "vitest";
import { AckReasonSchema, uuidv7 } from "@mfc/protocol";
import type { CommandEntry, CommandKind, CommandStatus } from "../../src/control/command-store";
import {
  ACK_TEXT_KEYS,
  ackReasonKey,
  commandLabelKey,
  entryVisual,
} from "../../src/control/ack-text";

/**
 * Builds a command entry with the given status.
 *
 * @param status - The status of the entry.
 * @returns The entry.
 */
function entryWith(status: CommandStatus): CommandEntry {
  return { commandId: uuidv7(), robotId: "sim-01", type: "PAUSE", sentAt: 0, status };
}

describe("ack text", () => {
  it("maps every refusal reason to its own key, and a DUPLICATE on an e-stop to already applied", () => {
    for (const reason of AckReasonSchema.options) {
      if (reason === "DUPLICATE") {
        continue;
      }
      expect(ackReasonKey(reason, "PAUSE")).toBe(`ack.reason.${reason}`);
    }
    expect(ackReasonKey("DUPLICATE", "PAUSE")).toBe("ack.reason.DUPLICATE");
    expect(ackReasonKey("DUPLICATE", "ESTOP")).toBe(ACK_TEXT_KEYS.alreadyApplied);
  });

  it("gives every command type a label key", () => {
    const types: CommandKind[] = [
      "PAUSE",
      "RESUME",
      "RETURN_TO_BASE",
      "ESTOP",
      "ESTOP_RELEASE",
      "SIMULATE_FAULT",
      "TAKE_CONTROL",
      "RELEASE_CONTROL",
    ];
    expect(new Set(types.map(commandLabelKey)).size).toBe(types.length);
    expect(commandLabelKey("ESTOP_RELEASE")).toBe("command.estop_release");
  });

  it("uses the acceptance visual for an ack, the pending visual while waiting, and the refusal visual otherwise", () => {
    expect(entryVisual(entryWith("pending"))).toBe("pending");
    expect(entryVisual(entryWith("ack"))).toBe("ack");
    expect(entryVisual(entryWith("reject"))).toBe("reject");
    expect(entryVisual(entryWith("no-answer"))).toBe("reject");
    expect(entryVisual(entryWith("failed"))).toBe("reject");
  });
});
