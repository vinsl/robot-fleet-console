// @vitest-environment jsdom
/**
 * The alerts sheet: active alerts grouped by severity in urgency order, the history tab with its next page, the
 * keyboard on the tabs, and the read-only note for a Viewer.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertsSheet } from "../../src/alerts/AlertsSheet";
import { alertOf } from "../live/support";
import {
  renderAlerts,
  resetAlertsState,
  signIn,
  type CannedResponse,
  type RecordedRequest,
} from "./alerts-harness";

const RESOLVED_AT = "2026-11-03T10:09:00.000Z";

const CRITICAL = alertOf({
  alertId: "1".repeat(32),
  kind: "ESTOP",
  severity: "CRITICAL",
  robotId: "sim-01",
  openedAt: "2026-11-03T10:00:00.000Z",
});
const MAJOR = alertOf({
  alertId: "2".repeat(32),
  kind: "BLOCKED",
  severity: "MAJOR",
  robotId: "sim-03",
  openedAt: "2026-11-03T10:02:00.000Z",
});
const RESOLVED_ONE = alertOf({
  alertId: "3".repeat(32),
  kind: "LOW_BATTERY",
  severity: "MINOR",
  robotId: "sim-07",
  status: "RESOLVED",
  openedAt: "2026-11-03T10:00:00.000Z",
  acknowledgedBy: "sub-0f9e-1a2b",
  acknowledgedAt: "2026-11-03T10:00:30.000Z",
  resolvedBy: "sub-0f9e-1a2b",
  resolvedAt: RESOLVED_AT,
});
const RESOLVED_TWO = alertOf({
  alertId: "4".repeat(32),
  kind: "LOW_BATTERY",
  severity: "MINOR",
  robotId: "sim-08",
  status: "RESOLVED",
  openedAt: "2026-11-03T08:00:00.000Z",
  acknowledgedBy: "sub-0f9e-1a2b",
  acknowledgedAt: "2026-11-03T08:00:30.000Z",
  resolvedBy: "sub-0f9e-1a2b",
  resolvedAt: "2026-11-03T08:05:00.000Z",
});

beforeEach(async () => {
  await resetAlertsState();
});

afterEach(() => {
  cleanup();
});

/**
 * Answers the list routes: active alerts for `status=active`, and a first resolved page with a next cursor for
 * `status=resolved`. A request for the next page gets the last alert and no cursor.
 *
 * @param request - The request.
 * @returns The canned response.
 */
function listResponse(request: RecordedRequest): CannedResponse {
  if (request.url.includes("cursor=")) {
    return { status: 200, body: { alerts: [RESOLVED_TWO] } };
  }
  if (request.url.includes("status=resolved")) {
    return { status: 200, body: { alerts: [RESOLVED_ONE], nextCursor: "Y3Vyc29yLTE" } };
  }
  return { status: 200, body: { alerts: [MAJOR, CRITICAL] } };
}

describe("AlertsSheet active tab", () => {
  it("groups the alerts by severity, most urgent first, whatever order the API used", async () => {
    signIn({ role: "Operator", userId: "operator-1" });
    renderAlerts(<AlertsSheet />, { respond: listResponse });
    const headings = await screen.findAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Critical", "Major"]);
  });

  it("tells a Viewer that the alerts are read-only and offers no action", async () => {
    signIn({ role: "Viewer", userId: "viewer-1" });
    renderAlerts(<AlertsSheet />, { respond: listResponse });
    expect(await screen.findByText("Viewers can read alerts but not change them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});

describe("AlertsSheet history tab", () => {
  it("loads the next page when Load more is pressed", async () => {
    const user = userEvent.setup();
    signIn({ role: "Operator", userId: "operator-1" });
    const { requests } = renderAlerts(<AlertsSheet />, { respond: listResponse });
    await user.click(await screen.findByRole("tab", { name: "History (24 h)" }));
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes("cursor=Y3Vyc29yLTE"))).toBe(true);
    });
    expect(await screen.findByText("Resolved by operator 1a2b after 9 min")).toBeTruthy();
  });

  it("is selected with the arrow keys and moves the focus with the selection", async () => {
    const user = userEvent.setup();
    signIn({ role: "Operator", userId: "operator-1" });
    renderAlerts(<AlertsSheet />, { respond: listResponse });
    const active = await screen.findByRole("tab", { name: "Active" });
    active.focus();
    await user.keyboard("{ArrowRight}");
    const history = screen.getByRole("tab", { name: "History (24 h)" });
    expect(history.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(history);
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Active" }).getAttribute("aria-selected")).toBe("true");
  });
});
