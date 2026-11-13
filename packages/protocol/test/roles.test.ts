/**
 * Role ordering: the highest role of a list applies, and an empty list grants nothing.
 */
import { describe, expect, it } from "vitest";
import { highestRole } from "../src/index";

describe("highestRole", () => {
  it("returns Admin over Viewer whatever the order", () => {
    expect(highestRole(["Viewer", "Admin"])).toBe("Admin");
    expect(highestRole(["Admin", "Viewer"])).toBe("Admin");
  });

  it("orders Viewer below Operator below Admin", () => {
    expect(highestRole(["Viewer", "Operator"])).toBe("Operator");
    expect(highestRole(["Operator", "Viewer"])).toBe("Operator");
  });

  it("returns the only role of a single-element list", () => {
    expect(highestRole(["Viewer"])).toBe("Viewer");
  });

  it("returns null for an empty list", () => {
    expect(highestRole([])).toBeNull();
  });
});
