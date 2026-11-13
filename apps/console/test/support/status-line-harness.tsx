/**
 * Renders the status line on its own, with the fake authentication client for the account menu.
 */
import { render } from "@testing-library/react";
import type { Role } from "@mfc/protocol";
import { ServicesProvider, type Services } from "../../src/app/services";
import { createServices } from "../../src/app/create-services";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { StatusLine } from "../../src/layout/StatusLine";
import type { WsState } from "../../src/ws/ws-client";
import { TEST_CONFIG } from "./console-harness";

/** Props accepted by the harness; every field has a default so each test names only what it checks. */
export interface StatusLineHarnessProps {
  readonly ws?: WsState;
  readonly api?: { readonly ok: boolean; readonly latencyMs: number | null };
  readonly robotsOnline?: number | null;
  readonly openAlerts?: number | null;
  readonly role?: Role | null;
}

/**
 * Renders the status line inside the services provider.
 *
 * @param props - The values to show.
 * @returns The services used.
 */
export function renderStatusLine(props: StatusLineHarnessProps): Services {
  const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
  render(
    <ServicesProvider value={services}>
      <StatusLine
        ws={props.ws ?? "open"}
        api={props.api ?? { ok: true, latencyMs: 12 }}
        robotsOnline={props.robotsOnline ?? null}
        openAlerts={props.openAlerts ?? null}
        role={props.role ?? "Viewer"}
      />
    </ServicesProvider>,
  );
  return services;
}
