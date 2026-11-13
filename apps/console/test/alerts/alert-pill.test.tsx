// @vitest-environment jsdom
/**
 * The alert pill: one open Major or Critical alert gives its sentence and a View button; several give their count
 * and a way to the sheet; an acknowledged alert raises nothing.
 */
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertPill } from "../../src/alerts/AlertPill";
import { useSelectionStore } from "../../src/live/selection-store";
import { alertOf } from "../live/support";
import { activeAlertsKey } from "../../src/api/alerts";
import { DEMO_SITE_ID, type AlertRecord } from "@mfc/protocol";
import { renderAlerts, resetAlertsState, signIn, type CannedResponse } from "./alerts-harness";

const MAJOR = alertOf({ alertId: "1".repeat(32), kind: "BLOCKED", robotId: "sim-03" });
const CRITICAL = alertOf({
  alertId: "2".repeat(32),
  kind: "ESTOP",
  severity: "CRITICAL",
  robotId: "sim-01",
});
const ACKNOWLEDGED = alertOf({
  alertId: "3".repeat(32),
  kind: "BLOCKED",
  robotId: "sim-05",
  status: "ACKNOWLEDGED",
  acknowledgedBy: "sub-0f9e-1a2b",
  acknowledgedAt: "2026-11-03T10:00:05.000Z",
});

beforeEach(async () => {
  await resetAlertsState();
  signIn({ role: "Operator", userId: "operator-1" });
});

afterEach(() => {
  cleanup();
});

/**
 * Lets pending promises and one macrotask run, so that the query of the render has settled.
 *
 * @returns A promise that resolves after the next macrotask.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Answers the active list with the given alerts.
 *
 * @param alerts - The alerts the API returns.
 * @returns A responder for {@link renderAlerts}.
 */
function activeList(alerts: readonly AlertRecord[]): () => CannedResponse {
  return () => ({ status: 200, body: { alerts } });
}

describe("AlertPill", () => {
  it("shows one open Major alert with its sentence and a View button", async () => {
    renderAlerts(<AlertPill />, { respond: activeList([MAJOR]) });
    expect(await screen.findByText("sim-03 blocked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
  });

  it("focuses the robot on the map and opens its page when View is pressed", async () => {
    const user = userEvent.setup();
    const { path } = renderAlerts(<AlertPill />, { respond: activeList([MAJOR]) });
    await user.click(await screen.findByRole("button", { name: "View" }));
    expect(path()).toBe("/robots/sim-03");
    expect(useSelectionStore.getState().focus?.robotId).toBe("sim-03");
  });

  it("shows the count of open alerts and an Open alerts button when there are several", async () => {
    const user = userEvent.setup();
    const { path } = renderAlerts(<AlertPill />, { respond: activeList([MAJOR, CRITICAL]) });
    expect(await screen.findByText("2 open alerts")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open alerts" }));
    expect(path()).toBe("/alerts");
  });

  it("shows nothing when the only alert is acknowledged", async () => {
    const { queryClient, view } = renderAlerts(<AlertPill />, {
      respond: activeList([ACKNOWLEDGED]),
    });
    queryClient.setQueryData(activeAlertsKey(DEMO_SITE_ID), [ACKNOWLEDGED]);
    await act(async () => {
      await settle();
    });
    expect(view.container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
