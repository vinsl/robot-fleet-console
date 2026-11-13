/**
 * @vitest-environment jsdom
 *
 * Closing the site sheet with an unsaved draft: the page asks first, keeps the work on "keep", drops it on
 * "discard", and closes at once when there is nothing to lose.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import "../../src/i18n";
import { createServices } from "../../src/app/create-services";
import { createQueryClient } from "../../src/app/query-client";
import { ServicesProvider } from "../../src/app/services";
import { useAuthStore } from "../../src/auth/auth-store";
import type { AuthClient } from "../../src/auth/cognito-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { RequireRole } from "../../src/auth/RequireRole";
import { SitePage } from "../../src/pages/SitePage";
import { createBackend, type Backend } from "../site/backend";
import { resetConsole, TEST_CONFIG } from "../support/console-harness";

// The parser runs in a worker, which the test environment does not have. The fixture drawing stands in for it.
vi.mock("../../src/site/dxf/worker-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/site/dxf/worker-client")>();
  const { SMALL_DOC } = await import("../site/editor/support");
  return { ...original, parseDxfFile: vi.fn(() => Promise.resolve(SMALL_DOC)) };
});

let backend: Backend;

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
  backend = createBackend();
  vi.stubGlobal("fetch", backend.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Renders the site route as the router mounts it, signed in as an Admin.
 *
 * @returns The user-event handle.
 */
async function renderSite(): Promise<ReturnType<typeof userEvent.setup>> {
  const auth: AuthClient = createFakeAuthClient();
  await auth.signIn("e2e-admin@example.test", "e2e-password");
  await auth.submitTotp("123456");
  useAuthStore.setState({ role: "Admin" });
  const services = createServices(TEST_CONFIG, { auth });
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
  return userEvent.setup();
}

/**
 * Picks a drawing, so the wizard holds a draft that is not saved.
 *
 * @param user - The user-event handle.
 */
async function pickDrawing(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) {
    throw new Error("no file input");
  }
  await user.upload(input, new File(["0"], "plan.dxf", { type: "application/dxf" }));
  await screen.findByRole("button", { name: "Continue to the editor" });
}

describe("closing the site sheet", () => {
  it("closes at once when there is no draft to lose", async () => {
    const user = await renderSite();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before dropping an unsaved draft, and keeps it on 'Keep editing'", async () => {
    const user = await renderSite();
    await pickDrawing(user);
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("alertdialog", { name: "Discard the unsaved draft?" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Site configuration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue to the editor" })).toBeTruthy();
  });

  it("keeps Tab inside the question while it is open", async () => {
    const user = await renderSite();
    await pickDrawing(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    const keep = screen.getByRole("button", { name: "Keep editing" });
    const discard = screen.getByRole("button", { name: "Discard draft" });

    await user.tab();
    expect(document.activeElement).toBe(discard);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);
  });

  it("returns the focus to the sheet's close button when the question is answered with 'Keep editing'", async () => {
    const user = await renderSite();
    await pickDrawing(user);
    const close = screen.getByRole("button", { name: "Close" });
    await user.click(close);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(document.activeElement).toBe(close);
  });

  it("answers the question with Escape and keeps the draft", async () => {
    const user = await renderSite();
    await pickDrawing(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Site configuration" })).toBeTruthy();
  });

  it("drops the draft and closes on 'Discard draft'", async () => {
    const user = await renderSite();
    await pickDrawing(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard draft" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
