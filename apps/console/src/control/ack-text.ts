/**
 * Text and visual keys of the command results: which label a command has, which words explain a refusal, and
 * which visual of `COMMAND_VISUALS` a log entry uses.
 *
 * The module returns keys, not strings, so that a component translates them with the namespace it already
 * uses. Labels live in the `robot` namespace; the command status sentences live in `states` (the visual table).
 */
import type { AckReason } from "@mfc/protocol";
import type { COMMAND_VISUALS } from "../theme/robot-state-visuals";
import type { CommandEntry, CommandKind } from "./command-store";

/** Keys of the texts that are not a refusal reason. They live in the `robot` namespace. */
export const ACK_TEXT_KEYS = {
  noAnswer: "ack.noAnswer",
  alreadyApplied: "ack.alreadyApplied",
  failed: "ack.failed",
} as const;

/** Label keys of the command types, in the `robot` namespace. Typed so that a new type cannot miss a label. */
const COMMAND_LABEL_KEYS: Readonly<Record<CommandKind, string>> = {
  PAUSE: "command.pause",
  RESUME: "command.resume",
  RETURN_TO_BASE: "command.return_to_base",
  ESTOP: "command.estop",
  ESTOP_RELEASE: "command.estop_release",
  SIMULATE_FAULT: "command.simulate_fault",
  TAKE_CONTROL: "command.take_control",
  RELEASE_CONTROL: "command.release_control",
};

/**
 * Key of the label of a command type.
 *
 * @param type - The command type.
 * @returns The key in the `robot` namespace.
 */
export function commandLabelKey(type: CommandKind): string {
  // eslint-disable-next-line security/detect-object-injection -- CommandKind is a closed union defined in code
  return COMMAND_LABEL_KEYS[type];
}

/**
 * Key of the reason text of a refusal. A `DUPLICATE` on an e-stop is not a fault: the robot already applied that
 * stop, so the text says so instead of "duplicate".
 *
 * @param reason - The refusal reason of the acknowledgement.
 * @param type - The command the refusal answers.
 * @returns The key in the `robot` namespace.
 */
export function ackReasonKey(reason: AckReason, type: CommandKind): string {
  if (reason === "DUPLICATE" && type === "ESTOP") {
    return ACK_TEXT_KEYS.alreadyApplied;
  }
  return `ack.reason.${reason}`;
}

/** Keys of `COMMAND_VISUALS` that a log entry can show. */
export type CommandVisualKey = keyof typeof COMMAND_VISUALS;

/**
 * Which visual a log entry uses. A request that failed or got no answer shows the refusal visual, because the
 * command did not visibly succeed; the text says which of the two happened.
 *
 * @param entry - The command entry.
 * @returns The key of `COMMAND_VISUALS`.
 */
export function entryVisual(entry: CommandEntry): CommandVisualKey {
  switch (entry.status) {
    case "pending":
      return "pending";
    case "ack":
      return "ack";
    case "reject":
    case "no-answer":
    case "failed":
      return "reject";
  }
}
