import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import fr from "../src/i18n/fr.json";
import { isMessageKey, localeFor, translate } from "../src/i18n";

const EN_KEYS = Object.keys(en).sort();
const FR_KEYS = Object.keys(fr).sort();

describe("translations", () => {
  it("has the same keys in English and French", () => {
    expect(FR_KEYS).toEqual(EN_KEYS);
  });

  it("has no empty value in either language", () => {
    for (const value of [...Object.values(en), ...Object.values(fr)]) {
      expect(value.trim()).not.toBe("");
    }
  });

  it("uses the same placeholders in both languages", () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? "").sort();
    for (const key of EN_KEYS) {
      expect(placeholders(fr[key as keyof typeof fr]), key).toEqual(
        placeholders(en[key as keyof typeof en]),
      );
    }
  });

  it("falls back to English for a language the page does not have", () => {
    expect(translate("de", "banner.estop")).toBe(en["banner.estop"]);
  });

  it("uses French for fr-FR and English for en-US", () => {
    expect(localeFor("fr-FR")).toBe("fr");
    expect(localeFor("en-US")).toBe("en");
    expect(translate(localeFor("fr-FR"), "button.stop")).toBe(fr["button.stop"]);
  });

  it("substitutes the placeholders", () => {
    expect(translate("en", "viewers", { count: 2, max: 3 })).toBe("Viewers 2/3");
    expect(translate("fr", "viewers", { count: 2, max: 3 })).toBe("Spectateurs 2/3");
  });

  it("recognises a message key and refuses any other string", () => {
    expect(isMessageKey("banner.estop")).toBe(true);
    expect(isMessageKey("toString")).toBe(false);
    expect(isMessageKey("unknown.key")).toBe(false);
  });
});
