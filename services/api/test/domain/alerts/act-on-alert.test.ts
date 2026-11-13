import { describe, expect, it } from "vitest";
import type { AlertActionRequest } from "@mfc/protocol";
import { actOnAlert } from "../../../src/domain/alerts/act-on-alert";
import { ALERT_PROBLEMS } from "../../../src/domain/alerts/problems";
import type { Clock } from "../../../src/domain/ports";
import {
  ALERT_ID,
  alertOf,
  alertsWorld,
  CALL,
  OPENED_AT,
  ROBOT_ID,
  SITE_ID,
  START_TIME,
  type AlertsWorld,
} from "../../fakes/alerts";

const REQUEST: AlertActionRequest = { openedAt: OPENED_AT };

/**
 * Stores an alert in a given status, with the fields the lifecycle sets for that status.
 *
 * @param world - The world of the test.
 * @param status - The status to store.
 */
function store(world: AlertsWorld, status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED"): void {
  const acknowledgement = {
    acknowledgedBy: "user-sub-1",
    acknowledgedAt: "2026-11-02T10:05:00.000Z",
  };
  const resolution = { resolvedBy: "user-sub-2", resolvedAt: "2026-11-02T10:10:00.000Z" };
  const record =
    status === "OPEN"
      ? alertOf()
      : status === "ACKNOWLEDGED"
        ? alertOf({ status, ...acknowledgement })
        : alertOf({ status, ...acknowledgement, ...resolution });
  world.store.put(record);
}

describe("actOnAlert: acknowledge", () => {
  it("acknowledges an OPEN alert in one transaction with its audit record, then relays it", async () => {
    const world = alertsWorld();
    store(world, "OPEN");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({
      ok: true,
      value: { changed: true, alert: { status: "ACKNOWLEDGED" } },
    });
    expect(world.store.transactions).toHaveLength(1);
    const [transaction] = world.store.transactions;
    expect(transaction?.kind).toBe("acknowledge");
    expect(transaction?.transition.audit).toMatchObject({
      siteId: SITE_ID,
      robotId: ROBOT_ID,
      alertId: ALERT_ID,
      actor: CALL.actor,
      actorSource: "mfc.jwt",
      action: "alert.acknowledge",
      result: "SUCCEEDED",
      correlationId: CALL.correlationId,
      ts: "2026-11-03T10:00:00.000Z",
    });
    expect(world.relay.changes).toHaveLength(1);
    expect(world.relay.changes[0]?.change).toBe("ACKNOWLEDGED");
    expect(world.metrics.value("AlertAcknowledged")).toBe(1);
  });

  it("stamps the audit record with the instant of the alert change, from a single clock read", async () => {
    const world = alertsWorld();
    store(world, "OPEN");
    // Each read moves the clock on, so a second read would give the audit record another instant.
    let ms = START_TIME.getTime();
    const clock: Clock = {
      now: () => {
        const instant = new Date(ms);
        ms += 7;
        return instant;
      },
    };

    await actOnAlert({ ...world.deps, clock }, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    const [transaction] = world.store.transactions;
    expect(transaction?.transition.next.acknowledgedAt).toBe("2026-11-03T10:00:00.000Z");
    expect(transaction?.transition.audit.ts).toBe(transaction?.transition.next.acknowledgedAt);
  });

  it("answers an ACKNOWLEDGED alert as an unchanged repeat, with no write, audit or relay", async () => {
    const world = alertsWorld();
    store(world, "ACKNOWLEDGED");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({ ok: true, value: { changed: false } });
    expect(world.store.transactions).toHaveLength(0);
    expect(world.audit.records).toHaveLength(0);
    expect(world.relay.changes).toHaveLength(0);
    expect(world.metrics.value("AlertActionReplayed")).toBe(1);
  });

  it("refuses a RESOLVED alert with 409 and audits the refusal", async () => {
    const world = alertsWorld();
    store(world, "RESOLVED");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.alreadyResolved });
    expect(world.store.transactions).toHaveLength(0);
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "alert.acknowledge",
      result: "REFUSED",
      problemType: "alert-state-conflict",
    });
    expect(world.metrics.value("AlertActionRefused")).toBe(1);
  });

  it("answers not found with 404, without any audit, when the alert is absent", async () => {
    const world = alertsWorld();

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.notFound });
    expect(world.audit.records).toHaveLength(0);
    expect(world.metrics.value("AlertNotFound")).toBe(1);
  });

  it("does not match an alert opened at another instant", async () => {
    const world = alertsWorld();
    store(world, "OPEN");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, {
      openedAt: "2026-11-02T11:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.notFound });
  });
});

describe("actOnAlert: resolve", () => {
  it("refuses an OPEN alert with 409 acknowledgeFirst and audits the refusal", async () => {
    const world = alertsWorld();
    store(world, "OPEN");

    const result = await actOnAlert(world.deps, CALL, "resolve", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.acknowledgeFirst });
    expect(world.store.transactions).toHaveLength(0);
    expect(world.audit.records[0]).toMatchObject({
      action: "alert.resolve",
      result: "REFUSED",
      problemType: "alert-state-conflict",
    });
  });

  it("resolves an ACKNOWLEDGED alert, relays RESOLVED and answers 200", async () => {
    const world = alertsWorld();
    store(world, "ACKNOWLEDGED");

    const result = await actOnAlert(world.deps, CALL, "resolve", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({
      ok: true,
      value: { changed: true, alert: { status: "RESOLVED" } },
    });
    expect(world.store.transactions[0]?.kind).toBe("resolve");
    expect(world.store.transactions[0]?.transition.audit.action).toBe("alert.resolve");
    expect(world.relay.changes[0]?.change).toBe("RESOLVED");
    expect(world.metrics.value("AlertResolved")).toBe(1);
  });

  it("answers a RESOLVED alert as an unchanged repeat", async () => {
    const world = alertsWorld();
    store(world, "RESOLVED");

    const result = await actOnAlert(world.deps, CALL, "resolve", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({ ok: true, value: { changed: false } });
    expect(world.store.transactions).toHaveLength(0);
    expect(world.relay.changes).toHaveLength(0);
  });
});

describe("actOnAlert: concurrent change", () => {
  it("re-reads after a lost condition and answers the state that holds", async () => {
    const world = alertsWorld();
    store(world, "OPEN");
    world.store.conflictNext(
      alertOf({
        status: "ACKNOWLEDGED",
        acknowledgedBy: "user-sub-1",
        acknowledgedAt: "2026-11-02T10:05:00.000Z",
      }),
    );

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({ ok: true, value: { changed: false } });
    expect(world.store.getCalls).toBe(2);
    expect(world.store.transactions).toHaveLength(1);
    expect(world.audit.records).toHaveLength(0);
    expect(world.relay.changes).toHaveLength(0);
  });

  it("refuses with 409 and audits when the condition is lost twice", async () => {
    const world = alertsWorld();
    store(world, "OPEN");
    world.store.conflictNext();
    world.store.conflictNext();

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.changed });
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "alert.acknowledge",
      result: "REFUSED",
      problemType: "alert-state-conflict",
      robotId: ROBOT_ID,
    });
    expect(world.relay.changes).toHaveLength(0);
  });
});

describe("actOnAlert: relay budget and audit failures", () => {
  it("skips the relay when less than 1500 ms remain, and still answers 200", async () => {
    const world = alertsWorld(1000);
    store(world, "OPEN");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toMatchObject({ ok: true, value: { changed: true } });
    expect(world.relay.changes).toHaveLength(0);
    expect(world.metrics.value("AlertRelaySkipped")).toBe(1);
  });

  it("still answers the refusal when the refused audit write fails, and counts the failure", async () => {
    const world = alertsWorld();
    store(world, "RESOLVED");
    world.audit.failure = new Error("throttled");

    const result = await actOnAlert(world.deps, CALL, "acknowledge", SITE_ID, ALERT_ID, REQUEST);

    expect(result).toEqual({ ok: false, problem: ALERT_PROBLEMS.alreadyResolved });
    expect(world.metrics.value("AuditWriteFailed")).toBe(1);
    expect(world.logger.text()).not.toContain("throttled");
  });
});
