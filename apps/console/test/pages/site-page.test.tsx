/**
 * @vitest-environment jsdom
 *
 * Site configuration sheet: the Admin frame and its tabs, and the refusal of every other role with no request
 * to the API.
 *
 * The tree is the route's own guard and page, not the whole shell: the shell opens the realtime connection and
 * the health poll, which would send requests that have nothing to do with this page and blur the zero-request
 * check.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@mfc/protocol";
import { MemoryRouter, Route, Routes } from "react-router";
import "../../src/i18n";
import { createServices } from "../../src/app/create-services";
import { ServicesProvider } from "../../src/app/services";
import { createQueryClient } from "../../src/app/query-client";
import { useAuthStore } from "../../src/auth/auth-store";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { RequireRole } from "../../src/auth/RequireRole";
import { SitePage } from "../../src/pages/SitePage";
import { QueryClientProvider } from "@tanstack/react-query";
import { resetConsole, TEST_CONFIG } from "../support/console-harness";

/** Stub of `fetch` that the test can count. */
let fetchSpy: ReturnType<typeof vi.fn>;

/**
 * Renders the site route as the router mounts it: the Admin guard around the page.
 *
 * @param role - The signed-in user's role.
 */
function renderSiteRoute(role: Role | null): void {
  useAuthStore.setState({ role });
  const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/site"]}>
          <Routes>
            <Route
              path="/site"
              element={
                <RequireRole allowed={["Admin"]}>
                  <SitePage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

beforeEach(async () => {
  resetConsole();
  fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal("fetch", fetchSpy);
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("site configuration sheet", () => {
  it("shows both sections to an Admin, with the editor selected", () => {
    renderSiteRoute("Admin");
    expect(screen.getByRole("dialog", { name: "Site configuration" })).toBeTruthy();
    const editor = screen.getByRole("tab", { name: "Editor" });
    const versions = screen.getByRole("tab", { name: "Versions" });
    expect(editor.getAttribute("aria-selected")).toBe("true");
    expect(versions.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tablist", { name: "Site sections" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("moves between the sections with the arrow, Home and End keys", async () => {
    const user = userEvent.setup();
    renderSiteRoute("Admin");
    const editor = screen.getByRole("tab", { name: "Editor" });
    editor.focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Versions" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Versions" }));

    await user.keyboard("{ArrowRight}");
    expect(editor.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Versions" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    await user.keyboard("{Home}");
    expect(editor.getAttribute("aria-selected")).toBe("true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("links each tab to the panel it controls", () => {
    renderSiteRoute("Admin");
    const tab = screen.getByRole("tab", { name: "Editor" });
    const panelId = tab.getAttribute("aria-controls");
    expect(panelId).not.toBeNull();
    const panel = document.getElementById(panelId ?? "");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
  });
});

describe("site configuration access", () => {
  it.each<Role | null>(["Operator", "Viewer", null])(
    "refuses the page to %s without a request to the API",
    (role) => {
      renderSiteRoute(role);
      expect(screen.getByRole("heading", { name: "Access denied" })).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
