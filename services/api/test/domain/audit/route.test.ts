import { describe, expect, it } from "vitest";
import { AUDIT_ROUTE_KEY, parseAuditRoute } from "../../../src/domain/audit/route";

describe("parseAuditRoute", () => {
  it("routes the audit read and validates the site of the path", () => {
    expect(parseAuditRoute(AUDIT_ROUTE_KEY, { siteId: "paris-01" })).toEqual({
      ok: true,
      siteId: "paris-01",
    });
  });

  it("refuses any other route key, as unknown", () => {
    expect(parseAuditRoute("DELETE /sites/{siteId}/audit", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "unknown-route",
    });
    expect(parseAuditRoute("GET /sites/{siteId}/alerts", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "unknown-route",
    });
  });

  it("refuses a site that is not a protocol identifier, or a missing one", () => {
    expect(parseAuditRoute(AUDIT_ROUTE_KEY, { siteId: "PARIS 01" })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(parseAuditRoute(AUDIT_ROUTE_KEY, undefined)).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });
});
