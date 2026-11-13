/**
 * Test harness of the component tests: renders the console with the fake authentication client and resets the
 * global stores between tests, as a fresh page load would.
 *
 * `fetch` is stubbed with a request that never settles, so the health poll and the realtime token request stay
 * pending and never reach the network.
 */
import { render } from "@testing-library/react";
import type { RuntimeConfig } from "@mfc/protocol";
import { App } from "../../src/App";
import { createServices } from "../../src/app/create-services";
import type { Services } from "../../src/app/services";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import type { AuthClient } from "../../src/auth/cognito-client";
import { useAuthStore } from "../../src/auth/auth-store";
import type { ServicesOverrides } from "../../src/app/create-services";
import { useFleetStore } from "../../src/live/fleet-store";
import { LANGUAGE_STORAGE_KEY } from "../../src/i18n";
import { useWsStore } from "../../src/ws/ws-store";
import { vi } from "vitest";

/** A configuration that passes the runtime schema. The hosts are placeholders, nothing is contacted. */
export const TEST_CONFIG: RuntimeConfig = {
  apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com",
  wsUrl: "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws",
  region: "eu-west-3",
  userPoolId: "eu-west-3_AbCdEf123",
  userPoolClientId: "abcdefghijklmnopqrstuvwxyz",
  identityPoolId: "eu-west-3:11111111-2222-3333-4444-555555555555",
};

/**
 * Resets the global stores and the page state to a fresh load: signed out, no connection, no stored language
 * preference, and a request stub that never settles.
 */
export function resetConsole(): void {
  resetStores();
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
}

/**
 * Clears the in-memory state of the page, as a reload does. The stored language is left alone: it survives a
 * reload by design.
 */
export function resetStores(): void {
  useAuthStore.setState({ status: "anonymous", role: null, step: null, signOutReason: null });
  useWsStore.setState({ connection: "idle", lastMessageAt: null });
  useFleetStore.getState().reset(Date.now());
}

/**
 * Renders the console at an address with the given authentication client.
 *
 * @param path - Address to open, for example `/sign-in`.
 * @param auth - Authentication client. Defaults to the fixture client.
 * @param overrides - Other clients to replace, such as a fake socket factory. Empty by default.
 * @returns The services the console was built with.
 */
export function renderConsole(
  path: string,
  auth: AuthClient = createFakeAuthClient(),
  overrides: Omit<ServicesOverrides, "auth"> = {},
): Services {
  window.history.replaceState(null, "", path);
  const services = createServices(TEST_CONFIG, { ...overrides, auth });
  render(<App services={services} />);
  return services;
}
