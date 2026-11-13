/**
 * @vitest-environment jsdom
 *
 * Sign-in steps that the fixture client does not reach: the first login (new password, TOTP enrolment with the
 * QR code) and the error messages. Each step is answered with a stub of the authentication client.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import { useAuthStore } from "../../src/auth/auth-store";
import { AuthError, type AuthClient } from "../../src/auth/cognito-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { renderConsole, resetConsole } from "../support/console-harness";

/** A TOTP secret for the enrolment. It is a fixture, not a real device secret. */
const SECRET = "JBSWY3DPEHPK3PXP";

/**
 * Builds a client whose first login goes through the new-password and enrolment steps.
 *
 * @returns The client.
 */
function firstLoginAuth(): AuthClient {
  const base = createFakeAuthClient();
  return {
    ...base,
    signIn: () => Promise.resolve({ kind: "new-password" }),
    completeNewPassword: () =>
      Promise.resolve({
        kind: "totp-setup",
        secretCode: SECRET,
        otpauthUri: `otpauth://totp/Fleet%20Console:e2e?secret=${SECRET}&issuer=Fleet%20Console`,
      }),
  };
}

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("sign-in page", () => {
  it("shows one message for a wrong password", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in");
    await user.type(screen.getByLabelText("Email"), "unknown@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect email or password.");
  });

  it("maps a locked account to its own message", async () => {
    const user = userEvent.setup();
    const base = createFakeAuthClient();
    renderConsole("/sign-in", {
      ...base,
      signIn: () => Promise.reject(new AuthError("locked")),
    });
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "anything");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait a few minutes before trying again.",
    );
  });

  it("explains that the session expired", () => {
    useAuthStore.setState({ signOutReason: "expired" });
    renderConsole("/sign-in");
    expect(screen.getByText("Your session has expired. Sign in again.")).toBeTruthy();
  });

  it("asks for a new password and refuses two different ones", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in", firstLoginAuth());
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "temporary");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("New password"), "First-choice-42!");
    await user.type(screen.getByLabelText("Confirm the new password"), "Second-choice-42!");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The two passwords do not match.");
  });

  it("lists the password rules, and ticks each one as the password is typed", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in", firstLoginAuth());
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "temporary");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const field = await screen.findByLabelText("New password");
    const rule = (text: RegExp): HTMLElement => {
      const item = screen.getByText(text).closest("li");
      if (item === null) {
        throw new Error("the rule is not in a list item");
      }
      return item;
    };

    expect(screen.getByText("The password must contain:")).toBeTruthy();
    for (const text of [/At least 12 characters/, /lowercase/, /uppercase/, /digit/, /special/]) {
      expect(rule(text).textContent).toContain("(missing)");
    }

    await user.type(field, "abcdefghijkl");
    expect(rule(/At least 12 characters/).textContent).toContain("(done)");
    expect(rule(/lowercase/).textContent).toContain("(done)");
    expect(rule(/uppercase/).textContent).toContain("(missing)");

    await user.type(field, "A1!");
    for (const text of [/At least 12 characters/, /lowercase/, /uppercase/, /digit/, /special/]) {
      expect(rule(text).textContent).toContain("(done)");
    }
  });

  it("refuses a password that breaks a rule before any request, and says so", async () => {
    const user = userEvent.setup();
    let requests = 0;
    const base = firstLoginAuth();
    renderConsole("/sign-in", {
      ...base,
      completeNewPassword: (password) => {
        requests += 1;
        return base.completeNewPassword(password);
      },
    });
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "temporary");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("New password"), "short-and-weak");
    await user.type(screen.getByLabelText("Confirm the new password"), "short-and-weak");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The password does not meet every rule in the list.",
    );
    expect(requests).toBe(0);
  });

  it("explains a refusal of the user pool with the rules still on screen", async () => {
    const user = userEvent.setup();
    const base = firstLoginAuth();
    renderConsole("/sign-in", {
      ...base,
      completeNewPassword: () => Promise.reject(new AuthError("password-policy")),
    });
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "temporary");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("New password"), "Same-choice-42!");
    await user.type(screen.getByLabelText("Confirm the new password"), "Same-choice-42!");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The password was refused. Check that it meets every rule in the list.",
    );
    expect(screen.getByText("The password must contain:")).toBeTruthy();
  });

  it("enrols the authenticator with a QR code and the secret as text", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in", firstLoginAuth());
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "temporary");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("New password"), "Same-choice-42!");
    await user.type(screen.getByLabelText("Confirm the new password"), "Same-choice-42!");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("heading", { name: "Set up two-step sign-in" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "QR code for your authenticator app" })).toBeTruthy();
    expect(screen.getByDisplayValue(SECRET).getAttribute("autocomplete")).toBe("off");
  });

  it("rejects a code that is not six digits before calling the service", async () => {
    const user = userEvent.setup();
    renderConsole("/sign-in", createFakeAuthClient());
    await user.type(screen.getByLabelText("Email"), "e2e-admin@example.test");
    await user.type(screen.getByLabelText("Password"), "e2e-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("Code from your app"), "12");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the 6-digit code.");
  });
});
