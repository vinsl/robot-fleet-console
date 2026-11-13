/**
 * @vitest-environment jsdom
 *
 * The dock: every role sees the Robots entry, and the Alerts entry carries the number of open alerts as text.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { DEMO_SITE_ID, type AlertRecord, type Role } from "@mfc/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import "../../src/i18n";
import { activeAlertsKey } from "../../src/api/alerts";
import { createServices } from "../../src/app/create-services";
import { ServicesProvider } from "../../src/app/services";
import { createQueryClient } from "../../src/app/query-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { Dock } from "../../src/layout/Dock";
import { resetConsole, TEST_CONFIG } from "../support/console-harness";
import { alertOf } from "../live/support";

/**
 * Renders the dock with a seeded active-alert list, inside the providers it needs.
 *
 * @param role - The role of the signed-in user.
 * @param alerts - Active alerts already in the cache.
 */
function renderDock(role: Role, alerts: readonly AlertRecord[]): void {
  const queryClient = createQueryClient();
  queryClient.setQueryData(activeAlertsKey(DEMO_SITE_ID), alerts);
  const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Dock role={role} />
        </MemoryRouter>
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

beforeEach(() => {
  resetConsole();
});

afterEach(() => {
  cleanup();
});

describe("Dock", () => {
  it.each<Role>(["Admin", "Operator", "Viewer"])("gives %s the Robots entry", (role) => {
    renderDock(role, []);
    expect(screen.getByRole("link", { name: "Robots" }).getAttribute("href")).toBe("/robots");
  });

  it("shows the number of open alerts on the Alerts entry", () => {
    renderDock("Operator", [alertOf()]);
    expect(screen.getByRole("link", { name: "Alerts 1 open" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 open" }).textContent).toBe("1");
  });

  it("shows no count when no alert is open", () => {
    renderDock("Operator", []);
    expect(screen.getByRole("link", { name: "Alerts" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /open/ })).toBeNull();
  });
});
