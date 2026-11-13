/**
 * Tests of the origin check of the upgrade request.
 */
import { describe, expect, it } from "vitest";
import { originAllowed } from "../../../src/domain/ws/origin";

const ALLOWED = ["https://console.example", "http://localhost:5173"];

describe("originAllowed", () => {
  it("accepts a request that carries no origin, since the token decides", () => {
    expect(originAllowed(undefined, ALLOWED)).toBe(true);
  });

  it("accepts an origin of the allow-list", () => {
    expect(originAllowed("http://localhost:5173", ALLOWED)).toBe(true);
  });

  it.each([
    ["a foreign site", "https://evil.example"],
    ["a look-alike host", "https://console.example.evil.example"],
    ["another port", "http://localhost:8080"],
    ["an empty origin", ""],
    ["a wildcard", "*"],
  ])("refuses %s", (_label, origin) => {
    expect(originAllowed(origin, ALLOWED)).toBe(false);
  });

  it("refuses every browser origin when the allow-list is empty", () => {
    expect(originAllowed("https://console.example", [])).toBe(false);
  });
});
