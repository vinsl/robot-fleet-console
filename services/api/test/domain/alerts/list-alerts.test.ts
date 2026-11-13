import { describe, expect, it } from "vitest";
import { AlertListQuerySchema } from "@mfc/protocol";
import { listAlerts } from "../../../src/domain/alerts/list-alerts";
import { ALERT_PROBLEMS } from "../../../src/domain/alerts/problems";
import { AlertCursorError } from "../../../src/domain/alerts/ports";
import { alertOf, alertsWorld, SITE_ID } from "../../fakes/alerts";

describe("listAlerts", () => {
  it("passes the validated query to the store and returns the page in store order", async () => {
    const world = alertsWorld();
    const first = alertOf({ alertId: "a".repeat(32) });
    const second = alertOf({ alertId: "b".repeat(32), kind: "LOW_BATTERY" });
    world.store.page = { alerts: [second, first], invalidItems: 0, nextCursor: "abc_-" };
    const query = AlertListQuerySchema.parse({ severity: "MAJOR", robotId: "sim-03", limit: "20" });

    const result = await listAlerts(world.deps, SITE_ID, query);

    expect(world.store.listRequests).toEqual([
      {
        siteId: SITE_ID,
        status: "active",
        severity: "MAJOR",
        robotId: "sim-03",
        since: undefined,
        limit: 20,
        cursor: undefined,
      },
    ]);
    expect(result).toEqual({ ok: true, value: { alerts: [second, first], nextCursor: "abc_-" } });
  });

  it("omits nextCursor on the last page", async () => {
    const world = alertsWorld();

    const result = await listAlerts(world.deps, SITE_ID, AlertListQuerySchema.parse({}));

    expect(result.ok).toBe(true);
    expect(result).toEqual({ ok: true, value: { alerts: [] } });
    if (result.ok) {
      expect(result.value).not.toHaveProperty("nextCursor");
    }
  });

  it("refuses a cursor that does not belong to this site and status with 400", async () => {
    const world = alertsWorld();
    world.store.listError = new AlertCursorError();

    const result = await listAlerts(
      world.deps,
      SITE_ID,
      AlertListQuerySchema.parse({ cursor: "abc" }),
    );

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.invalidCursor });
    expect(world.logger.text()).not.toContain("abc");
  });

  it("rethrows any other store failure", async () => {
    const world = alertsWorld();
    world.store.listError = new Error("dynamodb unavailable");

    await expect(listAlerts(world.deps, SITE_ID, AlertListQuerySchema.parse({}))).rejects.toThrow(
      "dynamodb unavailable",
    );
  });

  it("counts each invalid stored item once and keeps the valid ones", async () => {
    const world = alertsWorld();
    const valid = alertOf();
    world.store.page = { alerts: [valid], invalidItems: 2 };

    const result = await listAlerts(world.deps, SITE_ID, AlertListQuerySchema.parse({}));

    expect(result).toEqual({ ok: true, value: { alerts: [valid] } });
    expect(world.metrics.value("AlertItemInvalid")).toBe(2);
    expect(
      world.logger.entries.filter((entry) => entry.message === "stored alert items left out"),
    ).toHaveLength(1);
  });
});
