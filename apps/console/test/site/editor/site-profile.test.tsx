/**
 * @vitest-environment jsdom
 *
 * Site name form: a name the protocol refuses is never sent, a refused save keeps the typed name and says so, and
 * a saved name is confirmed.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SITE_ID } from "@mfc/protocol";
import "../../../src/i18n";
import type { AuthClient } from "../../../src/auth/cognito-client";
import { createServices } from "../../../src/app/create-services";
import { createQueryClient } from "../../../src/app/query-client";
import { ServicesProvider } from "../../../src/app/services";
import { createFakeAuthClient } from "../../../src/auth/fake-auth-client";
import { SiteProfile } from "../../../src/site/editor/SiteProfile";
import { createBackend, jsonResponse, siteFixture, type Backend } from "../backend";
import { resetConsole, TEST_CONFIG } from "../../support/console-harness";

/** Route of the site, read and written by the form. */
const SITE = `/sites/${DEMO_SITE_ID}`;

let backend: Backend;

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
  backend = createBackend();
  backend.on(`GET ${SITE}`, () => jsonResponse(200, siteFixture(null)));
  backend.on(`PUT ${SITE}`, () => jsonResponse(200, { ...siteFixture(null), name: "Warehouse B" }));
  vi.stubGlobal("fetch", backend.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Renders the form with the fixture client signed in.
 */
async function renderProfile(): Promise<void> {
  const auth: AuthClient = createFakeAuthClient();
  await auth.signIn("e2e-admin@example.test", "e2e-password");
  await auth.submitTotp("123456");
  const services = createServices(TEST_CONFIG, { auth });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={createQueryClient()}>
        <SiteProfile />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  await screen.findByRole("textbox", { name: "Site name" });
}

describe("site name form", () => {
  it("refuses an empty name without sending it", async () => {
    const user = userEvent.setup();
    await renderProfile();
    await user.clear(screen.getByRole("textbox", { name: "Site name" }));
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(screen.getByRole("textbox", { name: "Site name" }).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      screen.getByText("Use 1 to 64 characters, without angle brackets or control characters."),
    ).toBeTruthy();
    expect(backend.calls.filter((call) => call.startsWith("PUT"))).toHaveLength(0);
  });

  it("keeps the typed name and reports the failure when the save is refused", async () => {
    backend.on(`PUT ${SITE}`, () => jsonResponse(500, { title: "internal" }));
    const user = userEvent.setup();
    await renderProfile();
    const input = screen.getByRole("textbox", { name: "Site name" });
    await user.clear(input);
    await user.type(input, "Warehouse B");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The name could not be saved. Try again.");
    expect(alert.textContent).not.toContain("internal");
    expect(screen.getByDisplayValue("Warehouse B")).toBeTruthy();
  });

  it("confirms a saved name", async () => {
    const user = userEvent.setup();
    await renderProfile();
    const input = screen.getByRole("textbox", { name: "Site name" });
    await user.clear(input);
    await user.type(input, "Warehouse B");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText("Site name saved.")).toBeTruthy();
    expect(backend.calls).toContain(`PUT ${SITE}`);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
