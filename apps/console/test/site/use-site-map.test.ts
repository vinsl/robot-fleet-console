/**
 * Retry rule of the map download: one more attempt for a transient failure, none for a body that can never
 * pass, and none for any other error.
 */
import { describe, expect, it } from "vitest";
import { SiteFetchError, type SiteFetchErrorKind } from "../../src/site/fetch-map";
import { shouldRetrySiteMap } from "../../src/site/use-site-map";

describe("shouldRetrySiteMap", () => {
  it.each<SiteFetchErrorKind>(["network", "timeout", "rejected"])(
    "retries one transient %s failure",
    (kind) => {
      expect(shouldRetrySiteMap(1, new SiteFetchError(kind))).toBe(true);
    },
  );

  it.each<SiteFetchErrorKind>(["invalid", "too-large"])(
    "never retries a %s body, which fails the same way again",
    (kind) => {
      expect(shouldRetrySiteMap(1, new SiteFetchError(kind))).toBe(false);
    },
  );

  it("stops after the one retry", () => {
    expect(shouldRetrySiteMap(2, new SiteFetchError("network"))).toBe(false);
  });

  it("does not retry an error that is not a download failure", () => {
    expect(shouldRetrySiteMap(1, new Error("boom"))).toBe(false);
    expect(shouldRetrySiteMap(1, undefined)).toBe(false);
  });
});
