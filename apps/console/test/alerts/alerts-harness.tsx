/**
 * Harness of the alerts component tests. The real API client runs over a stubbed `fetch`, so every response goes
 * through the same schemas as in production. The harness also provides the query cache, the services and a
 * router, and reports the current path so that navigation can be asserted.
 */
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router";
import i18n from "i18next";
import { vi } from "vitest";
import { ServicesProvider, type Services } from "../../src/app/services";
import { createServices } from "../../src/app/create-services";
import { createApiClient } from "../../src/api/http-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { useAuthStore } from "../../src/auth/auth-store";
import { useSoundPreference } from "../../src/live/sound-preference";
import { useSelectionStore } from "../../src/live/selection-store";
import "../../src/i18n";
import { TEST_CONFIG } from "../support/console-harness";

/** One request the stubbed API received. The body is kept as sent, so no caller parses it. */
export interface RecordedRequest {
  /** HTTP method. */
  readonly method: string;
  /** Absolute URL. */
  readonly url: string;
  /** Raw request body, or `undefined` when none was sent. */
  readonly body: string | undefined;
}

/** A canned API response. */
export interface CannedResponse {
  /** HTTP status. */
  readonly status: number;
  /** JSON body. */
  readonly body: unknown;
}

/** What a test gets back from {@link renderAlerts}. */
export interface AlertsHandle {
  /** Every request the API client sent, in order. */
  readonly requests: readonly RecordedRequest[];
  /** The query cache of the render, so that tests can seed or read it. */
  readonly queryClient: QueryClient;
  /** Services of the render. */
  readonly services: Services;
  /** Pathname of the router at the time of the call. */
  readonly path: () => string;
  /** The Testing Library handle. */
  readonly view: RenderResult;
}

/** Options of {@link renderAlerts}. */
export interface RenderAlertsOptions {
  /** Initial address of the router. */
  readonly route?: string;
  /** Decides the response of each API request. Defaults to an empty alert list. */
  readonly respond?: (request: RecordedRequest) => CannedResponse;
}

/** Signed-in user the components read. */
export interface SignedInUser {
  /** Role of the user. */
  readonly role: "Viewer" | "Operator" | "Admin";
  /** Subject of the user. */
  readonly userId: string;
}

/**
 * Restores the language, the mute preference, the focus request and the auth store to a fresh page.
 * Call from `beforeEach`.
 */
export async function resetAlertsState(): Promise<void> {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  useSoundPreference.setState({ muted: false, blocked: false });
  useSelectionStore.setState({ focus: null });
  useAuthStore.setState({
    status: "anonymous",
    role: null,
    step: null,
    userId: null,
    signOutReason: null,
  });
}

/**
 * Signs a user into the auth store, as the shell does after sign-in.
 *
 * @param user - Role and subject of the user.
 */
export function signIn(user: SignedInUser): void {
  useAuthStore.setState({
    status: "authenticated",
    role: user.role,
    userId: user.userId,
  });
}

/**
 * Builds the `fetch` stub. Each call is recorded and answered by `respond`.
 *
 * @param requests - The list the recorded requests are appended to.
 * @param respond - Chooses the response.
 * @returns The stub.
 */
function fetchStub(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => CannedResponse,
): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    const canned = respond(request);
    return Promise.resolve(
      new Response(JSON.stringify(canned.body), {
        status: canned.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

/**
 * Renders a component under the alerts providers, with the API client on a stubbed `fetch`.
 *
 * @param ui - The component under test.
 * @param options - Route and API responses.
 * @returns The handle.
 */
export function renderAlerts(ui: ReactElement, options: RenderAlertsOptions = {}): AlertsHandle {
  const requests: RecordedRequest[] = [];
  const respond = options.respond ?? (() => ({ status: 200, body: { alerts: [] } }));
  const fetchFn = fetchStub(requests, respond);
  vi.stubGlobal("fetch", fetchFn);

  const auth = createFakeAuthClient();
  const base = createServices(TEST_CONFIG, { auth });
  const services: Services = {
    ...base,
    api: createApiClient(
      TEST_CONFIG,
      {
        getAccessToken: () => Promise.resolve("test-token"),
        signOut: () => Promise.resolve(),
      },
      { fetchFn },
    ),
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const location: { pathname: string } = { pathname: "" };

  /** Records the current pathname on every render of the router. */
  function PathProbe(): null {
    location.pathname = useLocation().pathname;
    return null;
  }

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider value={services}>
        <MemoryRouter initialEntries={[options.route ?? "/alerts"]}>
          {ui}
          <PathProbe />
        </MemoryRouter>
      </ServicesProvider>
    </QueryClientProvider>,
  );

  return {
    requests,
    queryClient,
    services,
    path: () => location.pathname,
    view,
  };
}
