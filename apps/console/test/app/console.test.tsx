/**
 * @vitest-environment jsdom
 *
 * Component-level version of the end-to-end scenarios (the Playwright suite is not installed). The console runs
 * with the fixture authentication client, the same build seam as `VITE_E2E=true`.
 *
 * Scenarios: sign-in with the TOTP code reaches the shell; a Viewer cannot open Users; sign-out clears the
 * session; the language choice persists; a reload returns to sign-in (tokens are never stored); the dock keeps
 * its keyboard order and hides the administration entries from an Operator.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import { LANGUAGE_STORAGE_KEY } from "../../src/i18n";
import { renderConsole, resetConsole, resetStores } from "../support/console-harness";

/** Fixture password and TOTP code of the end-to-end accounts. */
const PASSWORD = "e2e-password";
const TOTP_CODE = "123456";

/**
 * Signs in with a fixture account, through the credentials and the TOTP code.
 *
 * @param email - Fixture account.
 */
async function signIn(email: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await user.type(await screen.findByLabelText("Code from your app"), TOTP_CODE);
  await user.click(screen.getByRole("button", { name: "Verify" }));
  await screen.findByRole("navigation", { name: "Main navigation" });
}

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("console scenarios", () => {
  it("signs in with the password and the TOTP code and shows the shell", async () => {
    renderConsole("/sign-in");
    await signIn("e2e-admin@example.test");
    expect(screen.getByRole("link", { name: "Fleet" })).toBeTruthy();
  });

  it("refuses a Viewer the site page with the Forbidden page", async () => {
    renderConsole("/sign-in");
    await signIn("e2e-viewer@example.test");
    window.history.pushState(null, "", "/site");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "Access denied" })).toBeTruthy();
  });

  it("shows no users entry and answers Not Found on /users", async () => {
    renderConsole("/sign-in");
    await signIn("e2e-admin@example.test");
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
    window.history.pushState(null, "", "/users");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("hides the administration entries from an Operator", async () => {
    renderConsole("/sign-in");
    await signIn("e2e-operator@example.test");
    expect(screen.getByRole("link", { name: "Alerts" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Site" })).toBeNull();
  });

  it("signs out and returns to the sign-in page", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in");
    await signIn("e2e-admin@example.test");
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });

  it("keeps the language choice across a reload, and the session does not survive it", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in");
    await signIn("e2e-admin@example.test");
    await user.click(screen.getByRole("button", { name: "FR" }));
    expect(await screen.findByRole("navigation", { name: "Navigation principale" })).toBeTruthy();
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");

    // A reload: the page state is gone, the stored language is not.
    cleanup();
    resetStores();
    renderConsole("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Connexion" })).toBeTruthy();
  });

  it("moves the keyboard through the status line and then the dock", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in");
    await signIn("e2e-viewer@example.test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Account" })).toBeTruthy();
    });
    const order: string[] = [];
    for (let stop = 0; stop < 11; stop += 1) {
      await user.tab();
      order.push(document.activeElement?.textContent ?? "");
    }
    // Stop 0 is the connection indicator (its text depends on the link state, so it is not compared).
    // Stop 1 is the alert sound toggle, whose text depends on the stored preference.
    expect(order[1]).toMatch(/^(Alert sound|Click to enable alert sound)/);
    // Stops 5 and 6 are the two KPI corner tiles, then the dock.
    expect(order.slice(2, 5)).toEqual(["EN", "FR", "Account"]);
    expect(order.slice(7, 10)).toEqual(["Fleet", "Alerts", "KPI"]);
  });
});
