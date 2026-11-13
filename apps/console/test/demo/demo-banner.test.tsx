// @vitest-environment jsdom
// @vitest-environment jsdom
/**
 * The demo banner: visible on the page while the demo mode is on, and absent while it is off.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import { DemoBanner } from "../../src/demo/DemoBanner";
import {
  renderAlerts,
  resetAlertsState,
  signIn,
  type RecordedRequest,
} from "../alerts/alerts-harness";

/**
 * Answers the demo state with a fixed value.
 *
 * @param enabled - Whether the demo mode is on.
 * @returns The responder.
 */
function demoState(
  enabled: boolean,
): (request: RecordedRequest) => { status: number; body: unknown } {
  return () => ({ status: 200, body: { enabled } });
}

beforeEach(async () => {
  await resetAlertsState();
  signIn({ role: "Viewer", userId: "9b1e0c2a-5d7f-4a6b-8c3e-1d2f3e4a3f9a" });
});

afterEach(() => {
  cleanup();
});

describe("DemoBanner", () => {
  it("demo-banner-visible-when-enabled", async () => {
    renderAlerts(<DemoBanner />, { route: "/", respond: demoState(true) });
    expect(await screen.findByText("DEMO MODE")).toBeTruthy();
    expect(screen.getByText("Simulated faults are audited")).toBeTruthy();
  });

  it("demo-banner-hidden-while-disabled", async () => {
    const { requests } = renderAlerts(<DemoBanner />, { route: "/", respond: demoState(false) });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(screen.queryByText("DEMO MODE")).toBeNull();
  });
});
