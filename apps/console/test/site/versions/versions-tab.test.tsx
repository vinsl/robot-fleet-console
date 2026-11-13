/**
 * @vitest-environment jsdom
 *
 * Versions tab: the list order and the actions each status allows, the two-step activation with its conflict,
 * the read-only view, and the refusal of every role but Admin with no request.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SITE_ID, type Role } from "@mfc/protocol";
import "../../../src/i18n";
import type { AuthClient } from "../../../src/auth/cognito-client";
import { createServices } from "../../../src/app/create-services";
import { createQueryClient } from "../../../src/app/query-client";
import { ServicesProvider } from "../../../src/app/services";
import { useAuthStore } from "../../../src/auth/auth-store";
import { createFakeAuthClient } from "../../../src/auth/fake-auth-client";
import { VersionsTab } from "../../../src/site/versions/VersionsTab";
import { createBackend, jsonResponse, siteFixture, versionFixture, type Backend } from "../backend";
import { resetConsole, TEST_CONFIG } from "../../support/console-harness";

/** Route of the version list. */
const LIST = `GET /sites/${DEMO_SITE_ID}/maps`;

/** Route of the activation of version 3. */
const ACTIVATE_3 = `POST /sites/${DEMO_SITE_ID}/maps/3/activate`;

let backend: Backend;

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
  backend = createBackend();
  backend.on(LIST, () =>
    jsonResponse(200, {
      versions: [
        versionFixture(1, "VALID", true),
        versionFixture(2, "PENDING"),
        versionFixture(3, "VALID"),
      ],
    }),
  );
  backend.on(ACTIVATE_3, () => jsonResponse(200, siteFixture(3)));
  vi.stubGlobal("fetch", backend.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Renders the tab for a role, with the fixture client signed in.
 *
 * @param role - The signed-in role.
 * @param canEdit - The `canEdit` prop of the tab.
 */
async function renderTab(role: Role, canEdit = true): Promise<void> {
  const auth: AuthClient = createFakeAuthClient();
  await auth.signIn("e2e-admin@example.test", "e2e-password");
  await auth.submitTotp("123456");
  useAuthStore.setState({ role });
  const services = createServices(TEST_CONFIG, { auth });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={createQueryClient()}>
        <VersionsTab canEdit={canEdit} />
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

describe("versions list", () => {
  it("lists the newest version first, with its status and the active badge", async () => {
    await renderTab("Admin");
    const table = await screen.findByRole("table", { name: "Map versions" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(["v3", "v2", "v1"]);
    expect(within(table).getAllByText("Active")).toHaveLength(1);
    expect(within(table).getByText("Pending")).toBeTruthy();
  });

  it("offers validation only for pending versions and activation only for a valid, inactive one", async () => {
    await renderTab("Admin");
    await screen.findByRole("table", { name: "Map versions" });
    expect(screen.getByRole("button", { name: "Validate v2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Validate v3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Activate v3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate v1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate v2" })).toBeNull();
  });

  it("hides validation and activation in the read-only view", async () => {
    await renderTab("Admin", false);
    await screen.findByRole("table", { name: "Map versions" });
    expect(screen.queryByRole("button", { name: "Validate v2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate v3" })).toBeNull();
    expect(screen.getByRole("button", { name: "View v3" })).toBeTruthy();
  });
});

describe("activation", () => {
  it("activates only after the second press, and sends one request", async () => {
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Activate v3" }));

    const confirm = screen.getByRole("button", { name: "Confirm activate v3" });
    expect(document.activeElement).toBe(confirm);
    expect(backend.calls.filter((call) => call === ACTIVATE_3)).toHaveLength(0);

    await user.click(confirm);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Version 3 is now the active map.");
    expect(backend.calls.filter((call) => call === ACTIVATE_3)).toHaveLength(1);
  });

  it("cancels the confirmation with Escape, without a request, and returns the focus to Activate", async () => {
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Activate v3" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Confirm activate v3" })).toBeNull();
    const activate = screen.getByRole("button", { name: "Activate v3" });
    expect(document.activeElement).toBe(activate);
    expect(backend.calls).not.toContain(ACTIVATE_3);
  });

  it("cancels the confirmation with its button and returns the focus to Activate", async () => {
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Activate v3" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Activate v3" }));
    expect(backend.calls).not.toContain(ACTIVATE_3);
  });

  it("reports a conflict on activation without the server text", async () => {
    backend.on(ACTIVATE_3, () => jsonResponse(409, { title: "stale" }));
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Activate v3" }));
    await user.click(screen.getByRole("button", { name: "Confirm activate v3" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The map changed before activation. Refresh the versions and try again.",
    );
    expect(alert.textContent).not.toContain("stale");
  });
});

describe("validation", () => {
  it("validates a pending version once", async () => {
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Validate v2" }));

    await vi.waitFor(() => {
      expect(backend.calls).toContain(`POST /sites/${DEMO_SITE_ID}/maps/2/validate`);
    });
    expect(backend.calls.filter((call) => call.includes("/validate"))).toHaveLength(1);
  });
});

describe("download", () => {
  it("reports a download that cannot start, with the fixed message and no server text", async () => {
    backend.on(`GET /sites/${DEMO_SITE_ID}/maps/1`, () => jsonResponse(500, { title: "internal" }));
    const user = userEvent.setup();
    await renderTab("Admin");
    await user.click(await screen.findByRole("button", { name: "Download v1" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The download could not start. Try again.");
    expect(alert.textContent).not.toContain("internal");
  });
});

describe("access", () => {
  it.each<Role>(["Operator", "Viewer"])(
    "renders nothing and sends no request to a %s",
    async (role) => {
      await renderTab(role);
      expect(screen.queryByRole("table")).toBeNull();
      expect(backend.calls.filter((call) => call.startsWith("GET"))).toHaveLength(0);
    },
  );
});
