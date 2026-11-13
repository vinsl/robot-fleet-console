/**
 * Every protocol value the control screens show has a sentence in both languages, so no code is ever displayed raw.
 */
import { describe, expect, it } from "vitest";
import {
  AckReasonSchema,
  AuditActionSchema,
  AuditResultSchema,
  ControlledCommandTypeSchema,
  FaultCodeSchema,
} from "@mfc/protocol";
import { RESOURCES, SUPPORTED_LANGUAGES } from "../../src/i18n";
import { ACK_TEXT_KEYS, ackReasonKey, commandLabelKey } from "../../src/control/ack-text";
import type { CommandKind } from "../../src/control/command-store";

/**
 * Looks up a dotted key in one namespace of one language.
 *
 * @param language - The language.
 * @param namespace - The namespace, for example `robot`.
 * @param key - The dotted key inside the namespace.
 * @returns The text, or `undefined` when the key does not resolve to a string.
 */
function textOf(language: string, namespace: string, key: string): unknown {
  const resources: unknown = RESOURCES[language as keyof typeof RESOURCES];
  let node: unknown = resources;
  for (const part of [namespace, ...key.split(".")]) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      return undefined;
    }
    node = Object.getOwnPropertyDescriptor(node, part)?.value;
  }
  return node;
}

/**
 * Asserts that a key resolves to a non-empty text in every language.
 *
 * @param namespace - The namespace.
 * @param key - The dotted key.
 */
function expectEveryLanguage(namespace: string, key: string): void {
  for (const language of SUPPORTED_LANGUAGES) {
    const text = textOf(language, namespace, key);
    expect(typeof text === "string" && text.trim() !== "", `${language}/${namespace}/${key}`).toBe(
      true,
    );
  }
}

describe("control strings", () => {
  it("has a label for every command type, including the lock commands", () => {
    const types: CommandKind[] = [
      ...ControlledCommandTypeSchema.options,
      "TAKE_CONTROL",
      "RELEASE_CONTROL",
    ];
    for (const type of types) {
      expectEveryLanguage("robot", commandLabelKey(type));
    }
  });

  it("has a sentence for every refusal reason, and for the texts that are not reasons", () => {
    for (const reason of AckReasonSchema.options) {
      expectEveryLanguage("robot", ackReasonKey(reason, "PAUSE"));
    }
    expectEveryLanguage("robot", ackReasonKey("DUPLICATE", "ESTOP"));
    for (const key of Object.values(ACK_TEXT_KEYS)) {
      expectEveryLanguage("robot", key);
    }
  });

  it("has a name for every fault code", () => {
    for (const fault of FaultCodeSchema.options) {
      expectEveryLanguage("robot", `fault.${fault}`);
    }
  });

  it("has a column title, a result and a label for every audit action", () => {
    for (const column of ["time", "who", "action", "robot", "result", "correlationId"]) {
      expectEveryLanguage("audit", `column.${column}`);
    }
    for (const result of AuditResultSchema.options) {
      expectEveryLanguage("audit", `result.${result}`);
    }
    for (const action of AuditActionSchema.options) {
      expectEveryLanguage("audit", `action.${action}`);
    }
  });

  it("has the demo banner and the video texts", () => {
    expectEveryLanguage("demo", "banner");
    expectEveryLanguage("demo", "detail");
    for (const key of ["loading", "unavailable", "noCamera", "latency"]) {
      expectEveryLanguage("robot", `video.${key}`);
    }
    expectEveryLanguage("robot", "lock.linkLost");
  });
});
