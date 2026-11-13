import { describe, expect, it } from "vitest";
import { classNames } from "../../src/lib/class-names";

describe("classNames", () => {
  it("joins the names that are present", () => {
    expect(classNames("glass", "panel")).toBe("glass panel");
  });

  it("skips absent, false and empty names", () => {
    expect(classNames("glass", undefined, null, false, "")).toBe("glass");
    expect(classNames(undefined)).toBe("");
  });
});
