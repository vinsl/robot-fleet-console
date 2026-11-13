/**
 * Site route builders: a route is built only from validated identifiers and versions, so a value from the UI
 * can never add a path segment.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SITE_ID, type MapVersionNumber, type SiteId } from "@mfc/protocol";
import { sitePaths } from "../../src/api/site";

/** Identifiers that the protocol grammar refuses, including path traversal and uppercase. */
const BAD_SITE_IDS: readonly SiteId[] = ["../admin", "Demo-Site", "a/b", "x", "", "demo site"];

/** Versions that are not positive integers. */
const BAD_VERSIONS = [0, -1, 1.5, Number.NaN] as const;

describe("sitePaths", () => {
  it("builds the site, map list and map routes for the demo site", () => {
    expect(sitePaths.site(DEMO_SITE_ID)).toBe(`/sites/${DEMO_SITE_ID}`);
    expect(sitePaths.maps(DEMO_SITE_ID)).toBe(`/sites/${DEMO_SITE_ID}/maps`);
    expect(sitePaths.map(DEMO_SITE_ID, 3)).toBe(`/sites/${DEMO_SITE_ID}/maps/3`);
  });

  it("builds the map route for the active map", () => {
    expect(sitePaths.map(DEMO_SITE_ID, "active")).toBe(`/sites/${DEMO_SITE_ID}/maps/active`);
  });

  it("builds the validate and activate routes of a version", () => {
    const version: MapVersionNumber = 2;
    expect(sitePaths.validate(DEMO_SITE_ID, version)).toBe(
      `/sites/${DEMO_SITE_ID}/maps/2/validate`,
    );
    expect(sitePaths.activate(DEMO_SITE_ID, version)).toBe(
      `/sites/${DEMO_SITE_ID}/maps/2/activate`,
    );
  });

  it.each(BAD_SITE_IDS)("refuses the site identifier %j with a TypeError", (siteId) => {
    const bad = siteId;
    expect(() => sitePaths.site(bad)).toThrow(TypeError);
    expect(() => sitePaths.maps(bad)).toThrow(TypeError);
    expect(() => sitePaths.map(bad, 1)).toThrow(TypeError);
    expect(() => sitePaths.validate(bad, 1)).toThrow(TypeError);
    expect(() => sitePaths.activate(bad, 1)).toThrow(TypeError);
  });

  it.each(BAD_VERSIONS)("refuses the version %s with a TypeError", (version) => {
    const bad = version;
    expect(() => sitePaths.map(DEMO_SITE_ID, bad)).toThrow(TypeError);
    expect(() => sitePaths.validate(DEMO_SITE_ID, bad)).toThrow(TypeError);
    expect(() => sitePaths.activate(DEMO_SITE_ID, bad)).toThrow(TypeError);
  });

  it("never lets a version string add a path segment", () => {
    // A string is not a version number; the cast feeds the runtime guard a value the type does not admit.
    const bad = "1/../../admin" as unknown as MapVersionNumber;
    expect(() => sitePaths.map(DEMO_SITE_ID, bad)).toThrow(TypeError);
  });
});
