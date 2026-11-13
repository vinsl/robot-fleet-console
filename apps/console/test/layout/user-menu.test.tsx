/**
 * @vitest-environment jsdom
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import { renderStatusLine } from "../support/status-line-harness";
import { resetConsole } from "../support/console-harness";

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("UserMenu", () => {
  it("opens from the account toggle and exposes sign-out", async () => {
    const user = userEvent.setup();
    renderStatusLine({});
    const toggle = screen.getByRole("button", { name: "Account" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("closes on a press outside the menu", async () => {
    const user = userEvent.setup();
    renderStatusLine({});
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(document.body);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("closes when focus leaves the account control", async () => {
    const user = userEvent.setup();
    renderStatusLine({});
    await user.click(screen.getByRole("button", { name: "Account" }));
    // The sign-out item has focus; the next Tab leaves the control.
    expect(screen.getByRole("button", { name: "Sign out" }).matches(":focus")).toBe(true);
    await user.tab();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
