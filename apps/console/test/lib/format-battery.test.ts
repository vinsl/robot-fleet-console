import { describe, expect, it } from "vitest";
import { formatBattery } from "../../src/lib/format-battery";

describe("formatBattery", () => {
  it("shows the tenth, with one decimal even for a whole number", () => {
    expect(formatBattery(79.37298500000983, "en")).toBe("79.4");
    expect(formatBattery(80, "en")).toBe("80.0");
    expect(formatBattery(0, "en")).toBe("0.0");
    expect(formatBattery(100, "en")).toBe("100.0");
  });

  it("follows the number style of the language", () => {
    expect(formatBattery(79.37, "fr")).toBe("79,4");
  });
});
