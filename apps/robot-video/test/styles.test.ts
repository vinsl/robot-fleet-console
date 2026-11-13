import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The page stylesheet, read as text: the test checks the source, not the cascade. */
const STYLES = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("design tokens in the page stylesheet", () => {
  it("imports the console tokens first", () => {
    expect(STYLES.trimStart().startsWith('@import "../../console/src/theme/tokens.css";')).toBe(
      true,
    );
  });

  it("has no hard-coded hex colour", () => {
    expect(STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("has no colour function such as rgb(), hsl() or color-mix()", () => {
    expect(STYLES).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\(/);
  });

  it("has no pixel font size, and no millisecond duration", () => {
    expect(STYLES).not.toMatch(/font-size:\s*\d/);
    expect(STYLES).not.toMatch(/\d\s*ms\b/);
  });

  it("uses a token for every colour declaration", () => {
    const colourDeclarations = [
      ...STYLES.matchAll(/\b(color|background|border[\w-]*|box-shadow|outline):\s*([^;]+);/g),
    ];
    expect(colourDeclarations.length).toBeGreaterThan(10);
    for (const [, property, value] of colourDeclarations) {
      if (value === undefined || /^(none|0|inherit|inset)/.test(value.trim())) {
        continue;
      }
      expect(value, property).toMatch(/var\(--/);
    }
  });
});
