/**
 * Realtime connection of the console to the WebSocket API.
 *
 * Every attempt fetches a new single-use token (ADR 0041) and puts it in the URL, which is never logged. A
 * dropped connection is retried with exponential backoff and full jitter, capped at 30 s, so a fleet of
 * consoles does not hammer the token endpoint after an outage. A rejected token request stops the client:
 * the session is over and the authentication client has already signed the user out.
 */
import {
  WS_MAX_CLIENT_MESSAGE_BYTES,
  WsClientMessageSchema,
  WsServerMessageSchema,
  type WsClientMessage,
  type WsServerMessage,
} from "@mfc/protocol";
import { computeBackoffMs, type BackoffOptions } from "../lib/backoff";
import { ApiError } from "../api/http-client";
import { tokens } from "../theme/tokens";

/** Connection state of the client, as shown by the status line. */
export type WsState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The part of the browser WebSocket the client uses. Injected so that tests run without a network. */
export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Builds a socket for a URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Dependencies of {@link createWsClient}. */
export interface WsClientDeps {
  /** Returns the WebSocket endpoint from the runtime configuration. */
  readonly getWsUrl: () => string;
  /** Fetches a fresh single-use token. Called once per attempt, never reused. */
  readonly fetchToken: () => Promise<string>;
  /** Receives every valid server frame that `accepts` lets through. */
  readonly onMessage: (message: WsServerMessage) => void;
  /**
   * Tells whether a valid frame may reach the consumers. A refused frame is counted as dropped, like an
   * invalid one. Defaults to accepting every frame.
   */
  readonly accepts?: ((message: WsServerMessage) => boolean) | undefined;
  /**
   * Called after each transition to `open`, so that the caller can send its subscription. Every
   * reconnection calls it again, because the server forgets the subscription with the connection.
   */
  readonly onOpen?: () => void;
  /** Socket factory. Defaults to the browser WebSocket. */
  readonly createSocket?: WebSocketFactory | undefined;
  /** Backoff curve. Defaults to 1 s base and 30 s cap. */
  readonly backoff?: BackoffOptions;
  /** Randomness of the backoff, in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/** Realtime client. One instance per page. */
export interface WsClient {
  /** Current connection state. */
  readonly state: WsState;
  /** Number of inbound frames dropped because they were invalid or refused by `accepts`. */
  readonly droppedMessages: number;
  /** Starts the connection. Calling it while connected or connecting has no effect. */
  connect(): void;
  /** Ends the connection by the user's choice. No reconnection follows. */
  close(): void;
  /**
   * Sends a client frame when the connection is open.
   *
   * @param message - The frame to send.
   * @returns `true` when the frame was sent; `false` when the connection is not open or the frame is invalid.
   */
  send(message: WsClientMessage): boolean;
  /**
   * Subscribes to state changes.
   *
   * @param listener - Called with each new state.
   * @returns A function that removes the listener.
   */
  subscribe(listener: (state: WsState) => void): () => void;
}

/** Backoff of the reconnection: 1 s base, 30 s cap, as in the design (ADR 0041). */
const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, capMs: 30_000 };

/**
 * Creates the browser socket.
 *
 * @param url - The endpoint with the token in its query string.
 * @returns The browser WebSocket.
 */
const browserSocket: WebSocketFactory = (url) => new WebSocket(url);

/**
 * Tells whether a failure means the session is over rather than the network being down.
 *
 * @param error - The value the token request rejected with.
 * @returns `true` when the API refused the caller.
 */
function isSessionOver(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "unauthorized";
}

/**
 * Creates the realtime client.
 *
 * @param deps - Endpoint, token source, message handler and optional test seams.
 * @returns The client, initially `idle`.
 */
export function createWsClient(deps: WsClientDeps): WsClient {
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const random = deps.random ?? Math.random;
  const createSocket = deps.createSocket ?? browserSocket;
  const accepts = deps.accepts ?? (() => true);

  let state: WsState = "idle";
  let socket: WebSocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  // Every connection attempt carries a generation number. A callback from an attempt that the user or the
  // client has since abandoned finds a stale number and does nothing.
  let generation = 0;
  let dropped = 0;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(next: WsState) => void>();

  /**
   * Changes the state and tells the listeners, once per actual change.
   *
   * @param next - The new state.
   */
  function setState(next: WsState): void {
    if (state === next) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  }

  /** Cancels the pending reconnection, if any. */
  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Starts the keep-alive while the connection is open. The ping keeps idle proxies and load balancers
   * from closing the socket; the server ignores it.
   */
  function startKeepAlive(): void {
    stopKeepAlive();
    keepAlive = setInterval(() => {
      sendMessage({ type: "ping" });
    }, tokens.live.pingIntervalMs);
  }

  /** Stops the keep-alive, if it runs. */
  function stopKeepAlive(): void {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  /**
   * Sends a client frame when the connection is open and the frame is valid.
   *
   * @param message - The frame to send.
   * @returns `true` when the frame was sent; `false` otherwise.
   */
  function sendMessage(message: WsClientMessage): boolean {
    const current = socket;
    if (current === null || state !== "open") {
      return false;
    }
    const parsed = WsClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return false;
    }
    const text = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(text).byteLength > WS_MAX_CLIENT_MESSAGE_BYTES) {
      return false;
    }
    current.send(text);
    return true;
  }

  /**
   * Abandons the current attempt and any pending reconnection.
   *
   * @param next - The state to end in.
   */
  function stop(next: WsState): void {
    generation += 1;
    cancelTimer();
    stopKeepAlive();
    socket = null;
    setState(next);
  }

  /**
   * Schedules the next attempt after a jittered delay.
   *
   * @param gen - The generation that failed.
   */
  function scheduleRetry(gen: number): void {
    const delay = computeBackoffMs(failures, backoff, random);
    failures += 1;
    setState("reconnecting");
    timer = setTimeout(() => {
      timer = null;
      void attempt(gen);
    }, delay);
  }

  /**
   * Parses one inbound frame. Anything that is not a valid server message is dropped and counted.
   *
   * @param data - The frame payload as received.
   */
  function handleFrame(data: unknown): void {
    if (typeof data !== "string") {
      dropped += 1;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      dropped += 1;
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(json);
    if (!parsed.success || !accepts(parsed.data)) {
      dropped += 1;
      return;
    }
    deps.onMessage(parsed.data);
  }

  /**
   * Runs one attempt: fetch a token, open the socket, and wire its handlers to this generation.
   *
   * @param gen - The generation this attempt belongs to.
   */
  async function attempt(gen: number): Promise<void> {
    let token: string;
    try {
      token = await deps.fetchToken();
    } catch (error) {
      if (gen !== generation) {
        return;
      }
      if (isSessionOver(error)) {
        stop("closed");
        return;
      }
      scheduleRetry(gen);
      return;
    }
    if (gen !== generation) {
      return;
    }

    const url = `${deps.getWsUrl()}?token=${encodeURIComponent(token)}`;
    let opened: WebSocketLike;
    try {
      opened = createSocket(url);
    } catch {
      scheduleRetry(gen);
      return;
    }
    socket = opened;
    opened.onopen = () => {
      if (gen !== generation) {
        return;
      }
      failures = 0;
      setState("open");
      startKeepAlive();
      deps.onOpen?.();
    };
    opened.onmessage = (event) => {
      if (gen === generation) {
        handleFrame(event.data);
      }
    };
    opened.onclose = () => {
      if (gen !== generation) {
        return;
      }
      socket = null;
      stopKeepAlive();
      scheduleRetry(gen);
    };
  }

  return {
    get state() {
      return state;
    },

    get droppedMessages() {
      return dropped;
    },

    connect() {
      if (state !== "idle" && state !== "closed") {
        return;
      }
      generation += 1;
      failures = 0;
      setState("connecting");
      void attempt(generation);
    },

    close() {
      const current = socket;
      stop("closed");
      current?.close(1000, "client closed");
    },

    send(message) {
      return sendMessage(message);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
