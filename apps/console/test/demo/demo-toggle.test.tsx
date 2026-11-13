// @vitest-environment jsdom
// @vitest-environment jsdom
/**
 * The demo switch in the account menu: only an Admin sees it, and a change is confirmed in the page before the
 * request is sent.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import { UserMenu } from "../../src/layout/UserMenu";
import {
  renderAlerts,
  resetAlertsState,
  signIn,
  type RecordedRequest,
} from "../alerts/alerts-harness";

const USER_ID = "9b1e0c2a-5d7f-4a6b-8c3e-1d2f3e4a3f9a";

/**
 * Answers the demo route: a GET reads `enabled`, a PUT answers with the value it was sent.
 *
 * @param enabled - The state the site is in before the change.
 * @returns The responder.
 */
function demoRoute(
  enabled: boolean,
): (request: RecordedRequest) => { status: number; body: unknown } {
  let current = enabled;
  return (request) => {
    if (request.method === "PUT") {
      const body = JSON.parse(request.body ?? "{}") as { enabled: boolean };
      current = body.enabled;
    }
    return { status: 200, body: { enabled: current } };
  };
}

beforeEach(async () => {
  await resetAlertsState();
});

afterEach(() => {
  cleanup();
});

describe("DemoSwitch in the account menu", () => {
  it("demo-toggle-admin-only", async () => {
    signIn({ role: "Admin", userId: USER_ID });
    const user = userEvent.setup();
    renderAlerts(<UserMenu />, { route: "/", respond: demoRoute(false) });
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByRole("switch", { name: "Demo mode" })).toBeTruthy();
  });

  it.each(["Viewer", "Operator"] as const)(
    "demo-toggle-denied-for-viewer-and-operator (%s)",
    async (role) => {
      signIn({ role, userId: USER_ID });
      const user = userEvent.setup();
      const { requests } = renderAlerts(<UserMenu />, { route: "/", respond: demoRoute(false) });
      await user.click(screen.getByRole("button", { name: "Account" }));
      expect(screen.queryByRole("switch", { name: "Demo mode" })).toBeNull();
      // The state is not even read for a role that cannot change it.
      expect(requests.some((request) => request.url.endsWith("/demo"))).toBe(false);
    },
  );

  it("confirms the change in the page before sending it", async () => {
    signIn({ role: "Admin", userId: USER_ID });
    const user = userEvent.setup();
    const { requests } = renderAlerts(<UserMenu />, { route: "/", respond: demoRoute(true) });
    await user.click(screen.getByRole("button", { name: "Account" }));

    const toggle = await screen.findByRole("switch", { name: "Demo mode" });
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);
    expect(
      screen.getByText("Turn demo mode off? Simulated faults are refused from now on."),
    ).toBeTruthy();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.body).toBe('{"enabled":false}');
  });

  it("keeps the state and shows an error when the change fails", async () => {
    signIn({ role: "Admin", userId: USER_ID });
    const user = userEvent.setup();
    renderAlerts(<UserMenu />, {
      route: "/",
      respond: (request) =>
        request.method === "PUT"
          ? { status: 500, body: {} }
          : { status: 200, body: { enabled: true } },
    });
    await user.click(screen.getByRole("button", { name: "Account" }));
    const toggle = await screen.findByRole("switch", { name: "Demo mode" });
    await waitFor(() => {
      expect(toggle.hasAttribute("disabled")).toBe(false);
    });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "The demo mode could not be changed. Try again.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
