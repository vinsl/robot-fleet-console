import { describe, expect, it } from "vitest";
import { parseAlertRoute, rolesOf } from "../../../src/domain/alerts/route";

const ALERT = "0123456789abcdef0123456789abcdef";

describe("parseAlertRoute", () => {
  it("routes the list key with a validated site", () => {
    expect(parseAlertRoute("GET /sites/{siteId}/alerts", { siteId: "paris-01" })).toEqual({
      ok: true,
      route: { name: "listAlerts", siteId: "paris-01" },
    });
  });

  it("routes the acknowledge and resolve keys with a validated alert id", () => {
    expect(
      parseAlertRoute("POST /sites/{siteId}/alerts/{alertId}/acknowledge", {
        siteId: "paris-01",
        alertId: ALERT,
      }),
    ).toEqual({
      ok: true,
      route: { name: "acknowledgeAlert", siteId: "paris-01", alertId: ALERT },
    });
    expect(
      parseAlertRoute("POST /sites/{siteId}/alerts/{alertId}/resolve", {
        siteId: "paris-01",
        alertId: ALERT,
      }),
    ).toEqual({
      ok: true,
      route: { name: "resolveAlert", siteId: "paris-01", alertId: ALERT },
    });
  });

  it("refuses an unknown route key", () => {
    expect(parseAlertRoute("DELETE /sites/{siteId}/alerts", { siteId: "paris-01" })).toEqual({
      ok: false,
      reason: "unknown-route",
    });
  });

  it("refuses a malformed site identifier", () => {
    expect(parseAlertRoute("GET /sites/{siteId}/alerts", { siteId: "Demo Site" })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(parseAlertRoute("GET /sites/{siteId}/alerts", undefined)).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("refuses an alert identifier of 31 characters or in upper case", () => {
    const key = "POST /sites/{siteId}/alerts/{alertId}/resolve";
    expect(parseAlertRoute(key, { siteId: "paris-01", alertId: ALERT.slice(1) })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(parseAlertRoute(key, { siteId: "paris-01", alertId: ALERT.toUpperCase() })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("refuses an action route without an alert identifier", () => {
    expect(
      parseAlertRoute("POST /sites/{siteId}/alerts/{alertId}/resolve", { siteId: "paris-01" }),
    ).toEqual({ ok: false, reason: "invalid-path" });
  });
});

describe("rolesOf", () => {
  it("lets every role list the alerts, Viewer included", () => {
    expect([...rolesOf("listAlerts")].sort()).toEqual(["Admin", "Operator", "Viewer"]);
  });

  it("lets only Admin and Operator act on an alert, never a Viewer", () => {
    expect([...rolesOf("acknowledgeAlert")].sort()).toEqual(["Admin", "Operator"]);
    expect([...rolesOf("resolveAlert")].sort()).toEqual(["Admin", "Operator"]);
    expect(rolesOf("acknowledgeAlert")).not.toContain("Viewer");
    expect(rolesOf("resolveAlert")).not.toContain("Viewer");
  });
});
