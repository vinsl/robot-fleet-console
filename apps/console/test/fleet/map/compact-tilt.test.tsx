/**
 * @vitest-environment jsdom
 *
 * The tilt of the map follows the compact layout: a narrow screen and a short one (a phone in landscape) both match.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompactTilt } from "../../../src/fleet/map/geometry-hooks";

/**
 * Stubs `matchMedia` so that only queries that contain the given fragment match.
 *
 * @param fragment - The text a matching query must contain.
 */
function matchOnly(fragment: string): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes(fragment),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCompactTilt", () => {
  it("is compact on a narrow screen", () => {
    matchOnly("max-width: 639px");
    expect(renderHook(() => useCompactTilt()).result.current).toBe(true);
  });

  it("is compact on a short landscape screen", () => {
    matchOnly("max-height: 500px");
    expect(renderHook(() => useCompactTilt()).result.current).toBe(true);
  });

  it("is not compact on a large screen", () => {
    matchOnly("never matches");
    expect(renderHook(() => useCompactTilt()).result.current).toBe(false);
  });
});
