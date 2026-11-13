/**
 * Doubles of the control tests: a WebSocket the test drives, and an API client whose fetch answers by route.
 *
 * The real HTTP and WebSocket clients are used, so the tests run through the same validation the console runs in
 * production. Only the transport (`fetch`, the socket) and the token source are replaced.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { uuidv7, type Ack, type AckReason, type LockState, type RobotId } from "@mfc/protocol";
import "../../src/i18n";
import { createApiClient, type ApiClient } from "../../src/api/http-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { ServicesProvider, type Services } from "../../src/app/services";
import { TEST_CONFIG } from "../support/console-harness";
import { createWsClient, type WebSocketLike, type WsClient } from "../../src/ws/ws-client";

/** Origin of the fake API. Only its shape matters; nothing is sent over the network. */
export const API_URL = "https://abc123defg.execute-api.eu-west-3.amazonaws.com";

/** WebSocket endpoint of the fake API. */
const WS_URL = "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws";

/** A well-formed single-use WebSocket token. */
const WS_TOKEN = "a".repeat(43);

/** Robot used by every control test. */
export const ROBOT: RobotId = "sim-01";

/** Site used by every control test. */
export const SITE = "paris-01";

/** Subject of the signed-in operator in the tests. */
export const SUB = "11111111-2222-3333-4444-555555555555";

/** Subject of another operator, who holds the lock in some tests. */
export const OTHER_SUB = "99999999-8888-7777-6666-555555555555";

/** A request as the fake API received it. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  /** The parsed JSON body, or `null` when the request had none. */
  readonly body: unknown;
}

/** Answers one request. Tests return a promise to keep a request pending. */
export type Responder = (request: RecordedRequest) => Promise<Response> | Response;

/** Socket double the test drives by hand. */
export class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

/** Everything a control test needs: the services, the fake API and the socket. */
export interface ControlHarness {
  /** Services built from the real clients over the doubles. */
  readonly services: Services;
  /** The query cache the components read. */
  readonly queryClient: QueryClient;
  /** Every request the API client sent, in order. */
  readonly requests: RecordedRequest[];
  /** Every socket the WebSocket client created. */
  readonly sockets: FakeSocket[];
  /**
   * Connects the WebSocket client and opens the socket it creates.
   *
   * @returns The open socket.
   */
  openSocket(): Promise<FakeSocket>;
  /**
   * Wraps a tree in the query cache and the services, for `renderHook` and `render`.
   *
   * @returns A wrapper component.
   */
  wrapper(): ({ children }: { readonly children: ReactNode }) => ReactNode;
}

/**
 * Builds a JSON response.
 *
 * @param status - HTTP status.
 * @param body - Body, serialised as JSON.
 * @returns The response.
 */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds the harness.
 *
 * @param respond - Answers each request of the fake API.
 * @returns The harness.
 */
export function createControlHarness(respond: Responder): ControlHarness {
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocket[] = [];

  /**
   * The fetch the API client uses. It records the request and hands it to the responder.
   *
   * @param input - The request URL.
   * @param init - Method and body.
   * @returns The response the responder chose.
   */
  const fetchFn = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const request: RecordedRequest = { method: init?.method ?? "GET", path: url.pathname, body };
    requests.push(request);
    return Promise.resolve(respond(request));
  };

  const api: ApiClient = createApiClient(
    { apiUrl: API_URL },
    { getAccessToken: () => Promise.resolve("token"), signOut: () => Promise.resolve() },
    { fetchFn },
  );

  const ws: WsClient = createWsClient({
    getWsUrl: () => WS_URL,
    fetchToken: () => Promise.resolve(WS_TOKEN),
    onMessage: () => undefined,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const services: Services = { auth: createFakeAuthClient(), api, ws, config: TEST_CONFIG };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  /**
   * Connects the socket and waits for the client to create it.
   *
   * @returns The open socket.
   */
  async function openSocket(): Promise<FakeSocket> {
    ws.connect();
    await vi.waitFor(() => {
      if (sockets.length !== 1) {
        throw new Error("socket not created yet");
      }
    });
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("socket missing");
    }
    socket.onopen?.(new Event("open"));
    return socket;
  }

  /**
   * Wrapper of the harness tree.
   *
   * @param props - The children.
   * @returns The providers around the children.
   */
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <ServicesProvider value={services}>{children}</ServicesProvider>
      </QueryClientProvider>
    );
  }

  return {
    services,
    queryClient,
    requests,
    sockets,
    openSocket,
    wrapper: () => Wrapper,
  };
}

/**
 * Builds a lock answer of the API.
 *
 * @param held - Whether a holder exists.
 * @param holder - The holder, when held.
 * @returns A lock state with the caller's `mine` computed.
 */
export function lockState(held: boolean, holder?: string): LockState {
  return held && holder !== undefined
    ? { robotId: ROBOT, held: true, holder, mine: holder === SUB }
    : { robotId: ROBOT, held: false, mine: false };
}

/**
 * Builds a valid lock action answer.
 *
 * @param lock - The lock state after the action.
 * @returns The response body.
 */
export function lockActionBody(lock: LockState): unknown {
  return { commandId: uuidv7(), correlationId: "corr-0001-abcd", changed: true, lock };
}

/**
 * Builds the robot's acknowledgement of a command.
 *
 * @param commandId - The command being answered.
 * @param reason - The refusal reason, or `undefined` for an acceptance.
 * @returns A validated-shape acknowledgement.
 */
export function ackOf(commandId: string, reason?: AckReason): Ack {
  const base = {
    schemaVersion: "1.0.0",
    messageId: uuidv7(),
    robotId: ROBOT,
    siteId: SITE,
    ts: "2026-11-04T10:00:00.000Z",
    seq: 1,
    bootId: uuidv7(),
    commandId,
    correlationId: "corr-0001-abcd",
    robotTs: "2026-11-04T10:00:00.000Z",
    state: "IDLE" as const,
  };
  return reason === undefined ? { ...base, result: "ACK" } : { ...base, result: "REJECT", reason };
}
