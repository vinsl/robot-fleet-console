/**
 * @vitest-environment jsdom
 *
 * The save of the editor, end to end through the real reducer, hooks and API client, against a scripted backend.
 * Each test checks what was sent, how many times, and what the operator reads afterwards. No presigned URL may
 * appear on screen.
 */
import { useReducer } from "react";
import type * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/i18n";
import { createServices } from "../../../src/app/create-services";
import { createQueryClient } from "../../../src/app/query-client";
import { ServicesProvider } from "../../../src/app/services";
import type { AuthClient } from "../../../src/auth/cognito-client";
import { createFakeAuthClient } from "../../../src/auth/fake-auth-client";
import { SiteEditor } from "../../../src/site/editor/SiteEditor";
import { wizardReducer, type WizardState } from "../../../src/site/editor/wizard-reducer";
import { createBackend, jsonResponse, S3_ORIGIN, versionFixture, type Backend } from "../backend";
import { completeDraftState } from "./draft-fixture";
import { DEMO_SITE_ID } from "@mfc/protocol";
import { TEST_CONFIG, resetConsole } from "../../support/console-harness";

/** The route that reserves a version. */
const RESERVE = `POST /sites/${DEMO_SITE_ID}/maps`;

/** Route of the validation of version 2. */
const VALIDATE = `POST /sites/${DEMO_SITE_ID}/maps/2/validate`;

/** Route of the activation of version 2. */
const ACTIVATE = `POST /sites/${DEMO_SITE_ID}/maps/2/activate`;

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
 * Hosts the editor over the real reducer.
 *
 * @param props - The state the editor starts from.
 * @returns The editor section.
 */
function Harness({ initial }: { readonly initial: WizardState }): React.JSX.Element {
  const [state, dispatch] = useReducer(wizardReducer, initial);
  return <SiteEditor state={state} dispatch={dispatch} onViewVersions={() => undefined} />;
}

/**
 * Signs the fixture client in: password, then the one-time code the fixture accepts.
 *
 * @param auth - The fixture client.
 * @param email - A fixture account.
 */
async function signInFixture(auth: AuthClient, email: string): Promise<void> {
  await auth.signIn(email, "e2e-password");
  await auth.submitTotp("123456");
}

/**
 * Renders the editor of a complete draft, signed in as an Admin.
 *
 * @returns The user-event handle.
 */
async function renderDraft(): Promise<ReturnType<typeof userEvent.setup>> {
  const auth = createFakeAuthClient();
  await signInFixture(auth, "e2e-admin@example.test");
  const services = createServices(TEST_CONFIG, { auth });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={createQueryClient()}>
        <Harness initial={completeDraftState()} />
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return userEvent.setup();
}

/** The save button of the editor. */
function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save as new version" });
}

describe("save of a complete draft", () => {
  it("reserves, uploads and validates one version, then offers activation", async () => {
    const user = await renderDraft();
    await user.click(saveButton());

    await screen.findByRole("heading", { name: "Version 2 is validated" });
    expect(backend.calls).toEqual([RESERVE, `POST ${S3_ORIGIN}/`, VALIDATE]);
    expect(screen.getByRole("button", { name: "Activate now" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("fleet-maps");
  });

  it("sends one reservation for a double click on save", async () => {
    const user = await renderDraft();
    await user.dblClick(saveButton());

    await screen.findByRole("heading", { name: "Version 2 is validated" });
    expect(backend.calls.filter((call) => call === RESERVE)).toHaveLength(1);
  });

  it("explains a refused upload, offers saving again, and never validates", async () => {
    backend.on(
      `POST ${S3_ORIGIN}/`,
      () => new Response("<Error>AccessDenied</Error>", { status: 403 }),
    );
    const user = await renderDraft();
    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The upload was refused, possibly because it expired. Save again.",
    );
    expect(backend.calls).not.toContain(VALIDATE);
    expect(screen.queryByRole("button", { name: "Retry validation" })).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    expect(alert.textContent).not.toContain("AccessDenied");
  });

  it("keeps the upload when validation is refused, and validates it again without a new slot", async () => {
    backend.on(VALIDATE, () => jsonResponse(500, { title: "internal" }));
    const user = await renderDraft();
    await user.click(saveButton());

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe(
      "The uploaded map could not be validated. Try again.",
    );
    backend.on(VALIDATE, () => jsonResponse(200, versionFixture(2, "VALID")));
    await user.click(screen.getByRole("button", { name: "Retry validation" }));

    await screen.findByRole("heading", { name: "Version 2 is validated" });
    expect(backend.calls.filter((call) => call === RESERVE)).toHaveLength(1);
    expect(backend.calls.filter((call) => call === VALIDATE)).toHaveLength(2);
  });

  it("reports a refused activation as a conflict, without the server text", async () => {
    backend.on(ACTIVATE, () => jsonResponse(409, { title: "version changed" }));
    const user = await renderDraft();
    await user.click(saveButton());
    await user.click(await screen.findByRole("button", { name: "Activate now" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "The map changed before activation. Refresh the versions and try again.",
    );
    expect(within(alert).queryByText(/version changed/)).toBeNull();
  });
});
