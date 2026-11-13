/**
 * The audit request of the console: the route carries the page size, the cursor and the filters, and the query key
 * is per filter while keeping the site prefix that an invalidation uses.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SITE_ID } from "@mfc/protocol";
import { AUDIT_KEY, auditPath, auditQueryKey } from "../../src/api/audit";

describe("auditPath", () => {
  it("sends only the limit when no cursor and no filter is given", () => {
    expect(auditPath(DEMO_SITE_ID, { limit: 50 })).toBe(`/sites/${DEMO_SITE_ID}/audit?limit=50`);
  });

  it("encodes the robot and the outcome filters, and the cursor, in the query string", () => {
    const path = auditPath(DEMO_SITE_ID, {
      limit: 50,
      cursor: "abc_DEF-123",
      robotId: "sim-03",
      result: "REFUSED",
    });

    const params = new URL(path, "https://api.test").searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("cursor")).toBe("abc_DEF-123");
    expect(params.get("robotId")).toBe("sim-03");
    expect(params.get("result")).toBe("REFUSED");
  });

  it("does not send a filter that is not set", () => {
    const path = auditPath(DEMO_SITE_ID, { limit: 50, result: "FAILED" });

    expect(path).not.toContain("robotId");
    expect(path).toContain("result=FAILED");
  });
});

describe("auditQueryKey", () => {
  it("keeps the site prefix, so that an invalidation of the site reaches every filter", () => {
    const key = auditQueryKey(DEMO_SITE_ID, { robotId: "sim-01", result: "REFUSED" });

    expect(key.slice(0, 2)).toEqual([AUDIT_KEY, DEMO_SITE_ID]);
  });

  it("differs for each filter, so that each has its own cache of pages", () => {
    const unfiltered = auditQueryKey(DEMO_SITE_ID);
    const refused = auditQueryKey(DEMO_SITE_ID, { result: "REFUSED" });
    const robot = auditQueryKey(DEMO_SITE_ID, { robotId: "sim-01" });

    expect(refused).not.toEqual(unfiltered);
    expect(robot).not.toEqual(refused);
    expect(auditQueryKey(DEMO_SITE_ID, {})).toEqual(unfiltered);
  });
});
