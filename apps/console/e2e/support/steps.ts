/**
 * The authentication steps of the deployed-URL demo scenario (ADR 0069): the first sign-in with the temporary
 * password, the new password and the TOTP enrolment; the sign-out; and the second sign-in with a TOTP code.
 *
 * Every step is a `test.step` with `box: true`, so an error raised inside it points at the call site and not at a
 * line that handles a password or the TOTP secret. The labels are imported from the locale files the console ships,
 * so a renamed string breaks the type check rather than the run.
 */
import { expect, test, type Page } from "@playwright/test";
import auth from "../../src/i18n/locales/en/auth.json" with { type: "json" };
import shell from "../../src/i18n/locales/en/shell.json" with { type: "json" };
import type { E2eState } from "./state";
import { nextFreshCode, stepOf, totp } from "./totp";

/** What the first sign-in hands to the second one: the TOTP secret and the time step of the enrolment code. */
export interface Enrolment {
  /** Base32 TOTP secret that Cognito generated for this run. It dies with the user. */
  readonly secret: string;
  /**
   * Time step of the code that confirmed the enrolment. Cognito refuses a code it already consumed, so the next
   * sign-in must wait for a later step.
   */
  readonly step: number;
}

/**
 * Checks that the console is signed in: the sign-in heading is gone and the main navigation is shown.
 *
 * @param page - The page of the test.
 */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: auth.signIn.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: shell.dock.label, exact: true })).toBeVisible();
}

/**
 * Signs in for the first time: the administrator's temporary password, a new password chosen by the operator, then
 * the TOTP enrolment, whose key is read from the enrolment screen and confirmed with a computed code.
 *
 * The key is read from the page rather than from the API, so the enrolment screen is part of what the test proves.
 *
 * @param page - The page of the test. It must be on a fresh session.
 * @param s - The state of the run: the e-mail, the temporary password and the new password.
 * @returns The TOTP secret and the time step of the enrolment code.
 * @throws {Error} When the enrolment screen shows no key.
 */
export function firstSignIn(page: Page, s: E2eState): Promise<Enrolment> {
  return test.step(
    "First sign-in: temporary password, new password, TOTP enrolment",
    async () => {
      await page.goto("/sign-in");
      await page.getByLabel(auth.signIn.email, { exact: true }).fill(s.email);
      await page.getByLabel(auth.signIn.password, { exact: true }).fill(s.temporaryPassword);
      await page.getByRole("button", { name: auth.signIn.submit, exact: true }).click();

      await expect(
        page.getByRole("heading", { name: auth.newPassword.title, exact: true }),
      ).toBeVisible();
      await page.getByLabel(auth.newPassword.password, { exact: true }).fill(s.password);
      await page.getByLabel(auth.newPassword.confirm, { exact: true }).fill(s.password);
      await page.getByRole("button", { name: auth.newPassword.submit, exact: true }).click();

      await expect(
        page.getByRole("heading", { name: auth.totpSetup.title, exact: true }),
      ).toBeVisible();
      const secret = await page
        .getByLabel(auth.totpSetup.secretLabel, { exact: true })
        .inputValue();
      if (secret.length === 0) {
        throw new Error("the TOTP enrolment screen shows no key");
      }
      // One clock reading for the code and its step: the step must be the one the code was computed for.
      const now = Date.now();
      const step = stepOf(now);
      await page.getByLabel(auth.totpSetup.code, { exact: true }).fill(totp(secret, now));
      await page.getByRole("button", { name: auth.totpSetup.submit, exact: true }).click();

      await expectSignedIn(page);
      return { secret, step };
    },
    { box: true },
  );
}

/**
 * Signs out from the account menu and checks that the sign-in page is shown.
 *
 * @param page - The page of the test, signed in.
 */
export function signOut(page: Page): Promise<void> {
  return test.step(
    "Sign out from the account menu",
    async () => {
      await page.getByRole("button", { name: shell.userMenu.label, exact: true }).click();
      await page.getByRole("button", { name: shell.userMenu.signOut, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: auth.signIn.title, exact: true }),
      ).toBeVisible();
    },
    { box: true },
  );
}

/**
 * Signs in again with the password and a TOTP code of the enrolled device. The code is taken from a later time step
 * than the enrolment code, so it is accepted.
 *
 * @param page - The page of the test, on the sign-in page.
 * @param s - The state of the run: the e-mail and the password.
 * @param secret - The TOTP secret from {@link firstSignIn}.
 * @param usedStep - The time step of the enrolment code.
 */
export function signInWithTotp(
  page: Page,
  s: E2eState,
  secret: string,
  usedStep: number,
): Promise<void> {
  return test.step(
    "Second sign-in: password and a fresh TOTP code",
    async () => {
      await page.getByLabel(auth.signIn.email, { exact: true }).fill(s.email);
      await page.getByLabel(auth.signIn.password, { exact: true }).fill(s.password);
      await page.getByRole("button", { name: auth.signIn.submit, exact: true }).click();

      await expect(page.getByRole("heading", { name: auth.totp.title, exact: true })).toBeVisible();
      const code = await nextFreshCode(secret, usedStep);
      await page.getByLabel(auth.totp.code, { exact: true }).fill(code);
      await page.getByRole("button", { name: auth.totp.submit, exact: true }).click();

      await expectSignedIn(page);
    },
    { box: true },
  );
}
