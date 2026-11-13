/**
 * Router and role matrix of the site API: every route key, the path parameters each one accepts, and the roles
 * that may call it.
 */
import { describe, expect, it } from "vitest";
import { parseSiteRoute, rolesOf, type SiteRouteName } from "../../src/domain/site/route";

describe("parseSiteRoute", () => {
  it.each([
    ["GET /sites/{siteId}", undefined, "getSite"],
    ["PUT /sites/{siteId}", undefined, "updateSite"],
    ["GET /sites/{siteId}/maps", undefined, "listMaps"],
    ["POST /sites/{siteId}/maps", undefined, "createMap"],
  ])("routes %s to %s with the site identifier", (routeKey, version, name) => {
    const result = parseSiteRoute(routeKey, { siteId: "paris-01", version });
    expect(result).toEqual({ ok: true, route: { name, siteId: "paris-01" } });
  });

  it("routes GET of a map to getMapUrl with the number", () => {
    const result = parseSiteRoute("GET /sites/{siteId}/maps/{version}", {
      siteId: "paris-01",
      version: "7",
    });
    expect(result).toEqual({
      ok: true,
      route: { name: "getMapUrl", siteId: "paris-01", ref: 7 },
    });
  });

  it("routes GET of the active map to getMapUrl with active", () => {
    const result = parseSiteRoute("GET /sites/{siteId}/maps/{version}", {
      siteId: "paris-01",
      version: "active",
    });
    expect(result).toEqual({
      ok: true,
      route: { name: "getMapUrl", siteId: "paris-01", ref: "active" },
    });
  });

  it.each([
    ["POST /sites/{siteId}/maps/{version}/validate", "validateMap"],
    ["POST /sites/{siteId}/maps/{version}/activate", "activateMap"],
  ])("routes %s to %s with a number", (routeKey, name) => {
    const result = parseSiteRoute(routeKey, { siteId: "paris-01", version: "3" });
    expect(result).toEqual({ ok: true, route: { name, siteId: "paris-01", version: 3 } });
  });

  it("refuses an unknown route key with unknown-route", () => {
    expect(parseSiteRoute("DELETE /sites/{siteId}", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "unknown-route",
    });
  });

  it("refuses a route key that differs only in case or spacing", () => {
    expect(parseSiteRoute("get /sites/{siteId}", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "unknown-route",
    });
  });

  it("refuses a site identifier outside the grammar with invalid-path", () => {
    expect(parseSiteRoute("GET /sites/{siteId}", { siteId: "Bad_Id" })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("refuses a request with no path parameters with invalid-path", () => {
    expect(parseSiteRoute("GET /sites/{siteId}", undefined)).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it.each(["0", "abc", "1/2", "07", "1e3", "-1", "7/../", "active"])(
    "refuses the version %s on a write route with invalid-path",
    (version) => {
      expect(
        parseSiteRoute("POST /sites/{siteId}/maps/{version}/validate", {
          siteId: "paris-01",
          version,
        }),
      ).toEqual({ ok: false, reason: "invalid-path" });
    },
  );

  it.each(["0", "abc", "1/2", "07", "active "])(
    "refuses the version %s on the map read with invalid-path",
    (version) => {
      expect(
        parseSiteRoute("GET /sites/{siteId}/maps/{version}", { siteId: "paris-01", version }),
      ).toEqual({ ok: false, reason: "invalid-path" });
    },
  );

  it("refuses a map route without a version with invalid-path", () => {
    expect(parseSiteRoute("GET /sites/{siteId}/maps/{version}", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });
});

describe("rolesOf", () => {
  const allRoles = ["Admin", "Operator", "Viewer"];
  const adminOnly = ["Admin"];

  it.each<[SiteRouteName, string[]]>([
    ["getSite", allRoles],
    ["getMapUrl", allRoles],
    ["updateSite", adminOnly],
    ["listMaps", adminOnly],
    ["createMap", adminOnly],
    ["validateMap", adminOnly],
    ["activateMap", adminOnly],
  ])("accepts the roles of %s exactly", (name, roles) => {
    expect([...rolesOf(name)]).toEqual(roles);
  });
});
