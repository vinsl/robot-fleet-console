// @vitest-environment jsdom
/**
 * The lifecycle chip and the alert row: each state has its icon and text, the buttons follow the role and the
 * status, the action calls the API with the alert's opening time, and a conflict is explained under the row.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertRow } from "../../src/alerts/AlertRow";
import { AlertChip } from "../../src/alerts/AlertChip";
import { alertOf } from "../live/support";
import {
  renderAlerts,
  resetAlertsState,
  signIn,
  type CannedResponse,
  type RecordedRequest,
} from "./alerts-harness";

const ALERT_ID = "0123456789abcdef0123456789abcdef";
const ACKNOWLEDGED = {
  status: "ACKNOWLEDGED",
  acknowledgedBy: "operator-1",
  acknowledgedAt: "2026-11-03T10:00:05.000Z",
};

beforeEach(async () => {
  await resetAlertsState();
});

afterEach(() => {
  cleanup();
});

describe("AlertChip", () => {
  it("shows the severity as text for an open alert", () => {
    renderChip({ severity: "MAJOR", status: "OPEN" });
    expect(screen.getByText("Major")).toBeTruthy();
    expect(iconCount()).toBe(1);
  });

  it("shows the acknowledged state with its severity text", () => {
    renderChip({ severity: "CRITICAL", status: "ACKNOWLEDGED" });
    expect(screen.getByText("Critical")).toBeTruthy();
  });

  it("shows Resolved with a check icon for a resolved alert", () => {
    renderChip({ severity: "MAJOR", status: "RESOLVED" });
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(iconCount()).toBe(1);
  });
});

describe("AlertRow", () => {
  it("offers Acknowledge on an open alert to an Operator", () => {
    signIn({ role: "Operator", userId: "operator-1" });
    renderAlerts(<AlertRow alert={alertOf({ alertId: ALERT_ID })} now={Date.now()} />);
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("offers Resolve on an acknowledged alert to an Admin", () => {
    signIn({ role: "Admin", userId: "admin-1" });
    renderAlerts(
      <AlertRow alert={alertOf({ alertId: ALERT_ID, ...ACKNOWLEDGED })} now={Date.now()} />,
    );
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("offers no action to a Viewer", () => {
    signIn({ role: "Viewer", userId: "viewer-1" });
    renderAlerts(<AlertRow alert={alertOf({ alertId: ALERT_ID })} now={Date.now()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the operator who acknowledged, and says you for the signed-in user", () => {
    signIn({ role: "Operator", userId: "operator-1" });
    renderAlerts(
      <AlertRow alert={alertOf({ alertId: ALERT_ID, ...ACKNOWLEDGED })} now={Date.now()} />,
    );
    expect(screen.getByText(/Acknowledged by you/)).toBeTruthy();
  });

  it("sends the acknowledge action with the opening time of the alert", async () => {
    const user = userEvent.setup();
    signIn({ role: "Operator", userId: "operator-1" });
    const { requests } = renderAlerts(
      <AlertRow alert={alertOf({ alertId: ALERT_ID })} now={Date.now()} />,
      { respond: acknowledgedResponse },
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => {
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    });
    const [post] = requests.filter((request) => request.method === "POST");
    expect(post?.url).toMatch(/\/sites\/paris-01\/alerts\/[0-9a-f]{32}\/acknowledge$/);
    expect(post?.body).toBe(JSON.stringify({ openedAt: "2026-11-03T10:00:00.000Z" }));
  });

  it("explains a conflict under the row with the conflict message", async () => {
    const user = userEvent.setup();
    signIn({ role: "Operator", userId: "operator-1" });
    renderAlerts(<AlertRow alert={alertOf({ alertId: ALERT_ID })} now={Date.now()} />, {
      respond: conflictResponse,
    });
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The alert changed meanwhile. The list was refreshed.")).toBeTruthy();
  });
});

/**
 * Counts the icons drawn in the rendered chip; each state has one, so the text is never the only cue.
 *
 * @returns The number of SVG icons.
 */
function iconCount(): number {
  return document.querySelectorAll("svg").length;
}

/**
 * Renders a chip alone.
 *
 * @param props - Severity and status.
 */
function renderChip(props: Parameters<typeof AlertChip>[0]): void {
  renderAlerts(<AlertChip {...props} />);
}

/**
 * Answers the acknowledge call with the alert acknowledged, and any other call with an empty list.
 *
 * @param request - The request.
 * @returns The canned response.
 */
function acknowledgedResponse(request: RecordedRequest): CannedResponse {
  if (request.method === "POST") {
    return {
      status: 200,
      body: {
        changed: true,
        alert: alertOf({ alertId: ALERT_ID, ...ACKNOWLEDGED }),
      },
    };
  }
  return { status: 200, body: { alerts: [] } };
}

/**
 * Answers every call with a lifecycle conflict.
 *
 * @returns The canned response.
 */
function conflictResponse(): CannedResponse {
  return {
    status: 409,
    body: {
      type: "urn:mfc:problem:alert-state-conflict",
      title: "Conflict",
      status: 409,
    },
  };
}
