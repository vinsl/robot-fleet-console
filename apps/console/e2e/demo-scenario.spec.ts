/**
 * The demo scenario on the deployed console (ADR 0069). An ephemeral Operator signs in through the real user pool
 * with MFA, takes the lock of an ephemeral simulated robot, pauses it, e-stops it, and signs out. The setup script
 * creates the user and the robot, and the teardown script deletes them.
 *
 * The page is never reloaded after sign-in: the tokens live in memory, so a reload would sign the user out (SEC-WEB-2).
 * No trace, video or screenshot is taken, because they would capture the passwords and the TOTP secret.
 */
import { expect, test } from "@playwright/test";
import auth from "../src/i18n/locales/en/auth.json" with { type: "json" };
import fleet from "../src/i18n/locales/en/fleet.json" with { type: "json" };
import robot from "../src/i18n/locales/en/robot.json" with { type: "json" };
import shell from "../src/i18n/locales/en/shell.json" with { type: "json" };
import states from "../src/i18n/locales/en/states.json" with { type: "json" };
import { loadState } from "./support/state";
import { firstSignIn, signInWithTotp, signOut } from "./support/steps";

const state = loadState();

/*
 * The acknowledgement lines of the command log: "<command> · <latency> ms", the template of `states.command.ack`.
 * They are literal patterns, not built from the locale at run time: the latency varies, and a literal keeps the
 * assertion readable. A change of wording fails the run and shows the line that was expected.
 */
const PAUSE_ACK = /^Pause · \d+ ms$/;
const ESTOP_ACK = /^E-stop · \d+ ms$/;

test.describe("demo scenario", () => {
  test.describe.configure({ mode: "serial" });

  test("unauthenticated visit is redirected to sign-in", async ({ page }) => {
    await test.step("Open the robots list without a session", async () => {
      await page.goto("/robots");
    });

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: auth.signIn.title, exact: true })).toBeVisible();
    await expect(page.getByText(state.robotId, { exact: true })).toHaveCount(0);
  });

  test("Operator signs in with MFA, takes the lock, pauses and e-stops the robot", async ({
    page,
  }) => {
    // The secret and the step stay in these two variables; no step or assertion below prints them.
    const enrolment = await firstSignIn(page, state);
    await signOut(page);
    await signInWithTotp(page, state, enrolment.secret, enrolment.step);

    // Client-side navigation only: a reload would drop the in-memory tokens (SEC-WEB-2).
    await test.step("Open the robot from the robots list", async () => {
      await page.getByRole("link", { name: shell.pages.robots, exact: true }).click();
      // The list shows the identifier, not the registry name; the name is checked on the robot panel.
      const row = page.getByRole("button", {
        name: fleet.robots.open.replace("{{robot}}", state.robotId),
        exact: true,
      });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page).toHaveURL((url) => url.pathname === `/robots/${state.robotId}`);
      await expect(page.getByText(state.robotName, { exact: true })).toBeVisible();
    });

    await test.step("Take control of the robot", async () => {
      await expect(page.getByText(robot.lock.free, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: robot.command.take_control, exact: true }).click();
      await expect(page.getByText(robot.lock.mine, { exact: true })).toBeVisible();
    });

    await test.step("Pause the robot and read the acknowledgement", async () => {
      await page.getByRole("button", { name: robot.command.pause, exact: true }).click();
      await expect(page.getByText(PAUSE_ACK)).toBeVisible();
    });

    await test.step("E-stop the robot and read the acknowledgement", async () => {
      // The e-stop has no confirmation dialog: a stop must not wait for one (FR-CMD-4).
      await page.getByRole("button", { name: robot.command.estop, exact: true }).click();
      await expect(page.getByText(ESTOP_ACK)).toBeVisible();
      // The state is named in the header, and the state history names it too: scope to the header.
      const header = page
        .getByRole("heading", { level: 3, name: state.robotId, exact: true })
        .locator("xpath=..");
      await expect(header.getByText(states.state.estop, { exact: true })).toBeVisible();
    });

    await signOut(page);
  });
});
