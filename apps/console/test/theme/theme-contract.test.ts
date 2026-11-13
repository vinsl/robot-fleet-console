import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enStates from "../../src/i18n/locales/en/states.json";
import frStates from "../../src/i18n/locales/fr/states.json";
import {
  ALERT_RESOLVED_VISUAL,
  ALERT_VISUALS,
  BADGE_VISUALS,
  COMMAND_VISUALS,
  CONNECTION_VISUALS,
  STATE_VISUALS,
} from "../../src/theme/robot-state-visuals";
import { color } from "../../src/theme/tokens";

/** Flattens nested JSON into dotted keys mapped to their string values. */
function flatten(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      for (const [k, v] of flatten(value, prefix === "" ? key : `${prefix}.${key}`)) out.set(k, v);
    }
  }
  return out;
}

/** Collects every `labelKey` string found in the visual tables. */
function labelKeys(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "labelKey" && typeof value === "string" ? [value] : labelKeys(value),
  );
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] ?? "").sort();

const en = flatten(enStates);
const fr = flatten(frStates);

describe("state labels", () => {
  const keys = labelKeys([
    STATE_VISUALS,
    BADGE_VISUALS,
    ALERT_VISUALS,
    ALERT_RESOLVED_VISUAL,
    COMMAND_VISUALS,
    CONNECTION_VISUALS,
  ]);

  it("collects the label keys of the visual tables", () => {
    expect(keys.length).toBeGreaterThan(20);
  });

  it.each(keys)("%s exists in English and French", (key) => {
    expect(en.has(key)).toBe(true);
    expect(fr.has(key)).toBe(true);
  });

  it("has the same keys in both languages", () => {
    expect([...fr.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it("uses the same interpolation placeholders in both languages", () => {
    for (const [key, text] of en) {
      expect(placeholders(fr.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });
});

describe("tokens.css mirrors tokens.ts", () => {
  /** Trims, lowercases hex and rewrites `rgba()` with canonical numbers, so `0.60` equals `0.6`. */
  const canonical = (text: string): string =>
    text
      .trim()
      .toLowerCase()
      .replace(
        /rgba\(([^)]*)\)/g,
        (_match, args: string) => `rgba(${args.split(",").map(Number).join(",")})`,
      );

  /** Custom property name to its canonical value, as the stylesheet declares it. */
  const declared = new Map<string, string>();
  for (const match of readFileSync("src/theme/tokens.css", "utf8").matchAll(
    /--([a-z0-9-]+)\s*:\s*([^;]+);/g,
  )) {
    declared.set(match[1] ?? "", canonical(match[2] ?? ""));
  }

  /** Name of the custom property of a token path: `color.glass.fill` is `--glass-fill`. */
  const cssName = (path: string): string =>
    path
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replaceAll(".", "-");

  it.each([...flatten(color)])("colour %s is declared as its custom property", (path, value) => {
    expect(declared.get(cssName(path)), `--${cssName(path)}`).toBe(canonical(value));
  });
});
