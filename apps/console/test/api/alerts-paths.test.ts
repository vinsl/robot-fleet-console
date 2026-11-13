/**
 * Alert routes: query strings carry only the given parameters, and identifiers are checked before they become
 * path segments.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SITE_ID } from "@mfc/protocol";
import { activeAlertsKey, alertActionPath, alertsPath } from "../../src/api/alerts";

const ALERT_ID = "0123456789abcdef0123456789abcdef";

describe("alertsPath", () => {
  it("adds only the parameters that are given", () => {
    expect(alertsPath(DEMO_SITE_ID, {})).toBe("/sites/paris-01/alerts");
    expect(
      alertsPath(DEMO_SITE_ID, { status: "resolved", since: "2026-11-03T10:00:00.000Z" }),
    ).toBe("/sites/paris-01/alerts?status=resolved&since=2026-11-03T10%3A00%3A00.000Z");
  });
});

describe("alertActionPath", () => {
  it("builds the route of the action on the alert", () => {
    expect(alertActionPath(DEMO_SITE_ID, ALERT_ID, "acknowledge")).toBe(
      `/sites/paris-01/alerts/${ALERT_ID}/acknowledge`,
    );
  });

  it("refuses a malformed alert identifier", () => {
    expect(() => alertActionPath(DEMO_SITE_ID, "ABC", "resolve")).toThrow(TypeError);
  });
});

describe("cache keys", () => {
  it("separate the active list from the resolved one of a site", () => {
    expect(activeAlertsKey(DEMO_SITE_ID)).toEqual(["alerts", "paris-01", "active"]);
  });
});
