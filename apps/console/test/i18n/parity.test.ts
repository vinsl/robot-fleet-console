/**
 * Translation parity: every language has the same namespaces and keys, with non-empty text and the same
 * placeholders for each key.
 */
import { describe, expect, it } from "vitest";
import { RESOURCES, SUPPORTED_LANGUAGES } from "../../src/i18n";

/** Flattens a nested resource into a map from dotted key to text. */
function flatten(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      for (const [childKey, text] of flatten(value, prefix === "" ? key : `${prefix}.${key}`)) {
        out.set(childKey, text);
      }
    }
  }
  return out;
}

/** Lists the `{{name}}` placeholders of a text, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1] ?? "").sort();
}

/** Every language as a map from namespace to flattened keys, so that no lookup uses a computed key. */
const flatByLanguage = new Map(
  Object.entries(RESOURCES).map(([language, namespaces]) => [
    language,
    new Map(
      Object.entries(namespaces).map(([namespace, resource]) => [namespace, flatten(resource)]),
    ),
  ]),
);

describe("i18n resources", () => {
  it("ships the supported languages and no others", () => {
    expect([...flatByLanguage.keys()].sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it("has the same namespaces and keys in every language", () => {
    const reference = flatByLanguage.get("en");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    for (const [language, namespaces] of flatByLanguage) {
      expect([...namespaces.keys()].sort(), language).toEqual([...reference.keys()].sort());
      for (const [namespace, keys] of namespaces) {
        expect([...keys.keys()].sort(), `${language}/${namespace}`).toEqual(
          [...(reference.get(namespace)?.keys() ?? [])].sort(),
        );
      }
    }
  });

  it("has no empty text and keeps the placeholders of each key", () => {
    const english = flatByLanguage.get("en");
    const french = flatByLanguage.get("fr");
    if (english === undefined || french === undefined) throw new Error("both languages must ship");

    for (const [namespace, englishKeys] of english) {
      const frenchKeys = french.get(namespace);
      for (const [key, text] of englishKeys) {
        const translated = frenchKeys?.get(key) ?? "";
        expect(text.trim(), `en/${namespace}/${key}`).not.toBe("");
        expect(translated.trim(), `fr/${namespace}/${key}`).not.toBe("");
        expect(placeholders(translated), `fr/${namespace}/${key}`).toEqual(placeholders(text));
      }
    }
  });
});
