/**
 * Parity between the page's banner mapping and the console's robot-state visuals (ADR 0037).
 *
 * The page is plain TypeScript and draws its own banner, so it cannot import the console's React
 * components. This test is the guard instead: when the console changes the shape or the token of the
 * e-stop or teleoperation state, the page fails until its mapping follows.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATE_VISUALS } from "../../console/src/theme/robot-state-visuals";
import { color } from "../../console/src/theme/tokens";
import { BANNER_VISUALS } from "../src/ui/banner";

/** The console's token file, the CSS mirror of `tokens.ts`. */
const TOKENS_CSS = readFileSync(
  new URL("../../console/src/theme/tokens.css", import.meta.url),
  "utf8",
);

/**
 * Reads the value of a CSS custom property declared on one line of the tokens file.
 *
 * @param name - The property name without `--`.
 * @returns The declared value, or undefined when the property does not exist.
 */
function cssToken(name: string): string | undefined {
  const prefix = `--${name}:`;
  const line = TOKENS_CSS.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
  return line?.trimStart().slice(prefix.length).split(";")[0]?.trim();
}

/**
 * WCAG 2.2 relative luminance of an sRGB hex colour (`#rrggbb`).
 *
 * @param hex - The colour.
 * @returns The relative luminance, from 0 to 1.
 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * WCAG contrast ratio of two hex colours.
 *
 * @param first - One colour.
 * @param second - The other colour.
 * @returns The ratio, from 1 to 21.
 */
function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

describe("banner parity with the console robot-state visuals", () => {
  it("draws the e-stop with the same octagon as the console", () => {
    expect(BANNER_VISUALS.ESTOP.shape).toBe("octagon");
    expect(STATE_VISUALS.ESTOP.shape).toBe("octagon");
  });

  it("draws teleoperation with the console's circle and dashed ring", () => {
    expect(STATE_VISUALS.TELEOP.shape).toBe("circle");
    expect(STATE_VISUALS.TELEOP.outerRing).toBe("dashed");
    expect(BANNER_VISUALS.TELEOP.shape).toBe("dashed-circle");
  });

  it("colours teleoperation with the same state token as the console", () => {
    expect(BANNER_VISUALS.TELEOP.tokenName).toBe("state-human");
    expect(STATE_VISUALS.TELEOP.color).toBe(color.state.human);
    expect(cssToken(BANNER_VISUALS.TELEOP.tokenName)?.toLowerCase()).toBe(
      color.state.human.toLowerCase(),
    );
  });

  it("colours the e-stop with the same state token as the console", () => {
    expect(BANNER_VISUALS.ESTOP.tokenName).toBe("state-estop");
    expect(STATE_VISUALS.ESTOP.color).toBe(color.state.estop);
    expect(cssToken(BANNER_VISUALS.ESTOP.tokenName)?.toLowerCase()).toBe(
      color.state.estop.toLowerCase(),
    );
  });
});

describe("banner tokens", () => {
  it("names only tokens that exist in the console token file", () => {
    for (const visual of Object.values(BANNER_VISUALS)) {
      expect(cssToken(visual.tokenName), visual.tokenName).toBeDefined();
    }
    for (const name of ["text-primary", "bg-raised"]) {
      expect(cssToken(name), name).toBeDefined();
    }
  });

  it("keeps the e-stop icon at 3:1 or more on the raised background", () => {
    const ratio = contrast(cssToken("state-estop") ?? "", cssToken("bg-raised") ?? "");
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it("keeps the teleoperation text at 4.5:1 or more on the raised background", () => {
    const ratio = contrast(cssToken("text-primary") ?? "", cssToken("bg-raised") ?? "");
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
