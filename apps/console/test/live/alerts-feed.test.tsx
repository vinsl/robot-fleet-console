// @vitest-environment jsdom
/**
 * Alerts cache patches from live frames: OPENED emits once, lifecycle moves between the lists, and a reconnection
 * refetches the alerts.
 */
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WsServerMessageSchema,
  DEMO_SITE_ID,
  type AlertListResponse,
  type AlertRecord,
} from "@mfc/protocol";
import { ALERTS_KEY, activeAlertsKey, resolvedAlertsKey } from "../../src/api/alerts";
import {
  applyAlertFrame,
  subscribeAlertOpened,
  useAlertFeed,
  type AlertOpenedListener,
} from "../../src/live/alerts-feed";
import { publishFrame } from "../../src/live/frame-bus";
import { useWsStore } from "../../src/ws/ws-store";
import { alertOf } from "./support";

type AlertChangedFrame = Extract<
  ReturnType<typeof WsServerMessageSchema.parse>,
  { type: "alert.changed" }
>;

const ACKED = {
  status: "ACKNOWLEDGED",
  acknowledgedBy: "operator-1",
  acknowledgedAt: "2026-11-03T10:00:05.000Z",
};
const RESOLVED = {
  status: "RESOLVED",
  acknowledgedBy: "operator-1",
  acknowledgedAt: "2026-11-03T10:00:05.000Z",
  resolvedBy: "operator-1",
  resolvedAt: "2026-11-03T10:00:09.000Z",
};

/**
 * Builds a validated `alert.changed` frame.
 *
 * @param change - What changed.
 * @param alert - The alert.
 * @returns The frame, narrowed to the alert variant.
 */
function alertFrameOf(
  change: "OPENED" | "ACKNOWLEDGED" | "RESOLVED",
  alert: AlertRecord,
): AlertChangedFrame {
  const frame = WsServerMessageSchema.parse({
    type: "alert.changed",
    siteId: DEMO_SITE_ID,
    change,
    alert,
  });
  if (frame.type !== "alert.changed") {
    throw new Error("fixture is not an alert frame");
  }
  return frame;
}

/**
 * Reads the active list from the cache.
 *
 * @param client - The query cache.
 * @returns The active alerts, or `undefined` when not loaded.
 */
function activeOf(client: QueryClient): readonly AlertRecord[] | undefined {
  return client.getQueryData<readonly AlertRecord[]>(activeAlertsKey(DEMO_SITE_ID));
}

/**
 * Builds a history cache with one page.
 *
 * @param alerts - The alerts of page 0.
 * @returns The infinite data.
 */
function historyOf(alerts: readonly AlertRecord[]): InfiniteData<AlertListResponse> {
  return { pages: [{ alerts: [...alerts] }], pageParams: [undefined] };
}

let client: QueryClient;

/** Removals of the opened-alert listeners of the current case. */
const removals: (() => void)[] = [];

/**
 * Subscribes a listener to opened alerts. The subscription is removed after the case, even when it fails,
 * so a listener never reaches a later case.
 *
 * @param listener - Called once per newly opened alert.
 */
function listenOpened(listener: AlertOpenedListener): void {
  removals.push(subscribeAlertOpened(listener));
}

beforeEach(() => {
  client = new QueryClient();
  useWsStore.setState({ connection: "idle" });
});

afterEach(() => {
  for (const remove of removals.splice(0)) {
    remove();
  }
  cleanup();
  vi.restoreAllMocks();
});

describe("applyAlertFrame", () => {
  it("adds an opened alert to the active list and emits it once", () => {
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), []);
    const opened: AlertRecord[] = [];
    listenOpened((alert) => {
      opened.push(alert);
    });
    const frame = alertFrameOf("OPENED", alertOf());

    applyAlertFrame(client, frame);
    applyAlertFrame(client, frame);

    expect(activeOf(client)?.map((alert) => alert.alertId)).toEqual([alertOf().alertId]);
    expect(opened).toHaveLength(1);
  });

  it("does not emit an alert the cache already holds as active", () => {
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), [alertOf()]);
    const opened: AlertRecord[] = [];
    listenOpened((alert) => {
      opened.push(alert);
    });
    applyAlertFrame(client, alertFrameOf("OPENED", alertOf()));
    expect(opened).toHaveLength(0);
  });

  it("keeps the severity order when an alert joins the list", () => {
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), [alertOf()]);
    const critical = alertOf({
      alertId: "fedcba9876543210fedcba9876543210",
      kind: "ESTOP",
      severity: "CRITICAL",
      robotId: "sim-01",
    });
    applyAlertFrame(client, alertFrameOf("OPENED", critical));
    expect(activeOf(client)?.map((alert) => alert.severity)).toEqual(["CRITICAL", "MAJOR"]);
  });

  it("replaces an acknowledged alert in place, without emitting", () => {
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), [alertOf()]);
    const opened: AlertRecord[] = [];
    listenOpened((alert) => {
      opened.push(alert);
    });
    applyAlertFrame(client, alertFrameOf("ACKNOWLEDGED", alertOf(ACKED)));
    expect(activeOf(client)).toHaveLength(1);
    expect(activeOf(client)?.[0]?.status).toBe("ACKNOWLEDGED");
    expect(opened).toHaveLength(0);
  });

  it("removes a resolved alert from active and puts it first in the history", () => {
    const older = alertOf({
      alertId: "00000000000000000000000000000001",
      openedAt: "2026-11-03T08:00:00.000Z",
      status: "RESOLVED",
      acknowledgedBy: "operator-1",
      acknowledgedAt: "2026-11-03T08:00:05.000Z",
      resolvedBy: "operator-1",
      resolvedAt: "2026-11-03T09:00:00.000Z",
    });
    const resolving = alertOf(RESOLVED);
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), [alertOf(ACKED)]);
    client.setQueryData(resolvedAlertsKey(DEMO_SITE_ID), historyOf([older]));

    applyAlertFrame(client, alertFrameOf("RESOLVED", resolving));

    expect(activeOf(client)).toEqual([]);
    const history = client.getQueryData<InfiniteData<AlertListResponse>>(
      resolvedAlertsKey(DEMO_SITE_ID),
    );
    expect(history?.pages[0]?.alerts.map((alert) => alert.alertId)).toEqual([
      resolving.alertId,
      older.alertId,
    ]);
  });

  it("leaves an unloaded cache alone rather than inventing a list", () => {
    applyAlertFrame(client, alertFrameOf("RESOLVED", alertOf(RESOLVED)));
    expect(activeOf(client)).toBeUndefined();
    expect(client.getQueryData(resolvedAlertsKey(DEMO_SITE_ID))).toBeUndefined();
  });
});

describe("useAlertFeed", () => {
  /**
   * Wraps the hook in a query client.
   *
   * @param children - The tree.
   * @returns The wrapped tree.
   */
  function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  it("applies alert frames published on the frame bus", () => {
    client.setQueryData(activeAlertsKey(DEMO_SITE_ID), []);
    renderHook(
      () => {
        useAlertFeed();
      },
      { wrapper },
    );

    act(() => {
      publishFrame(alertFrameOf("OPENED", alertOf()));
    });
    expect(activeOf(client)).toHaveLength(1);
  });

  it("refetches the alerts after a reconnection, but not on the first open", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    useWsStore.setState({ connection: "open" });
    renderHook(
      () => {
        useAlertFeed();
      },
      { wrapper },
    );
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      useWsStore.getState().setConnection("reconnecting");
    });
    act(() => {
      useWsStore.getState().setConnection("open");
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [ALERTS_KEY] });
  });
});
