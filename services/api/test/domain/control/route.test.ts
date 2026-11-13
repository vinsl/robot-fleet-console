/**
 * Routing and the role matrix of the control API.
 */
import { describe, expect, it } from "vitest";
import { parseControlRoute, rolesOf } from "../../../src/domain/control/route";

const SITE = { siteId: "paris-01" };
const ROBOT = { siteId: "paris-01", robotId: "sim-03" };

describe("parseControlRoute", () => {
  it("routes every control key with validated parameters", () => {
    expect(parseControlRoute("GET /sites/{siteId}/robots", SITE)).toEqual({
      ok: true,
      route: { name: "listRobots", siteId: "paris-01" },
    });
    expect(parseControlRoute("GET /sites/{siteId}/robots/{robotId}/lock", ROBOT)).toEqual({
      ok: true,
      route: { name: "getLock", siteId: "paris-01", robotId: "sim-03" },
    });
    expect(parseControlRoute("POST /sites/{siteId}/robots/{robotId}/lock", ROBOT).ok).toBe(true);
    expect(parseControlRoute("POST /sites/{siteId}/robots/{robotId}/lock/release", ROBOT)).toEqual({
      ok: true,
      route: { name: "releaseLock", siteId: "paris-01", robotId: "sim-03" },
    });
    expect(parseControlRoute("POST /sites/{siteId}/robots/{robotId}/commands", ROBOT)).toEqual({
      ok: true,
      route: { name: "sendCommand", siteId: "paris-01", robotId: "sim-03" },
    });
    expect(parseControlRoute("GET /sites/{siteId}/demo", SITE)).toEqual({
      ok: true,
      route: { name: "getDemo", siteId: "paris-01" },
    });
    expect(parseControlRoute("PUT /sites/{siteId}/demo", SITE)).toEqual({
      ok: true,
      route: { name: "setDemo", siteId: "paris-01" },
    });
  });

  it("refuses an unknown route key", () => {
    expect(parseControlRoute("DELETE /sites/{siteId}/robots/{robotId}/lock", ROBOT)).toEqual({
      ok: false,
      reason: "unknown-route",
    });
  });

  it("refuses a malformed site or robot identifier", () => {
    expect(parseControlRoute("GET /sites/{siteId}/demo", { siteId: "Bad Site" })).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(
      parseControlRoute("POST /sites/{siteId}/robots/{robotId}/commands", {
        siteId: "paris-01",
        robotId: "X",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-path",
    });
    expect(parseControlRoute("POST /sites/{siteId}/robots/{robotId}/commands", undefined)).toEqual({
      ok: false,
      reason: "invalid-path",
    });
  });
});

describe("rolesOf", () => {
  it("lets every role read, Operators and Admins act, and only the Admin change the demo mode", () => {
    expect(rolesOf("listRobots")).toEqual(["Admin", "Operator", "Viewer"]);
    expect(rolesOf("getLock")).toEqual(["Admin", "Operator", "Viewer"]);
    expect(rolesOf("getDemo")).toEqual(["Admin", "Operator", "Viewer"]);
    expect(rolesOf("acquireLock")).toEqual(["Admin", "Operator"]);
    expect(rolesOf("releaseLock")).toEqual(["Admin", "Operator"]);
    expect(rolesOf("sendCommand")).toEqual(["Admin", "Operator"]);
    expect(rolesOf("setDemo")).toEqual(["Admin"]);
  });
});
