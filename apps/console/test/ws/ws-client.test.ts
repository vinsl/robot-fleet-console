/**
 * Realtime client: token per attempt, jittered capped backoff, stop on refused session, user close, frame
 * validation. Timers are faked, so the reconnection schedule is checked exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServerMessage } from "@mfc/protocol";
import { ApiError } from "../../src/api/http-client";
import { createWsClient, type WebSocketLike, type WsState } from "../../src/ws/ws-client";
import { live as liveTokens } from "../../src/theme/tokens";

const WS_URL = "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws";
const PRESENCE_FRAME = JSON.stringify({
  type: "robot.presence",
  siteId: "paris-01",
  robotId: "robot-01",
  presence: "ONLINE",
  at: "2026-11-03T10:00:00.000Z",
});

/** Browser socket double that the test drives by hand. */
class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulates the server accepting the upgrade. */
  open(): void {
    this.onopen?.(new Event("open"));
  }

  /** Simulates the connection ending. */
  serverClose(): void {
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }

  /**
   * Simulates a frame from the server.
   *
   * @param data - The raw payload.
   */
  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

let sockets: FakeSocket[];
let tokens: number;

/**
 * Creates a client wired to the fake socket and a numbered token source.
 *
 * @param overrides - Dependencies to replace.
 * @returns The client, the received messages and the token fetch spy.
 */
function setup(
  overrides: {
    fetchToken?: () => Promise<string>;
    accepts?: (message: WsServerMessage) => boolean;
  } = {},
) {
  const received: WsServerMessage[] = [];
  const fetchToken = vi.fn(
    overrides.fetchToken ?? (() => Promise.resolve(`tok-${String(++tokens)}`)),
  );
  const client = createWsClient({
    getWsUrl: () => WS_URL,
    fetchToken,
    onMessage: (message) => {
      received.push(message);
    },
    accepts: overrides.accepts,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.999999,
  });
  return { client, received, fetchToken };
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  tokens = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection", () => {
  it("fetches a token, opens the socket with it, and reports each state once", async () => {
    const { client } = setup();
    const states: WsState[] = [];
    client.subscribe((state) => {
      states.push(state);
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe(`${WS_URL}?token=tok-1`);
    sockets[0]?.open();
    expect(client.state).toBe("open");
    expect(states).toEqual(["connecting", "open"]);
  });

  it("does not reconnect after the user closes the connection", async () => {
    const { client, fetchToken } = setup();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();

    client.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sockets[0]?.closed).toBe(true);
    expect(client.state).toBe("closed");
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });
});

describe("reconnection", () => {
  it("waits with growing delays capped at 30 s, and requests a new token each time", async () => {
    const delays: number[] = [];
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const { client, fetchToken } = setup();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < 7; attempt += 1) {
      sockets.at(-1)?.serverClose();
      const call = scheduled.mock.calls.at(-1);
      if (call !== undefined && typeof call[1] === "number") {
        delays.push(call[1]);
      }
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(delays).toEqual([999, 1999, 3999, 7999, 15999, 29999, 29999]);
    expect(delays.every((delay) => delay <= 30_000)).toBe(true);
    expect(fetchToken).toHaveBeenCalledTimes(8);
    const urls = sockets.map((socket) => socket.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(client.state).toBe("reconnecting");
  });

  it("stops and reports closed when the API refuses the token as unauthorized", async () => {
    const { client, fetchToken } = setup({
      fetchToken: () => Promise.reject(new ApiError("unauthorized", 401, null)),
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.state).toBe("closed");
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });

  it("retries after a network failure while fetching the token", async () => {
    let calls = 0;
    const { client, fetchToken } = setup({
      fetchToken: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new TypeError("offline"))
          : Promise.resolve("tok-after");
      },
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(sockets[0]?.url).toBe(`${WS_URL}?token=tok-after`);
  });
});

describe("messages", () => {
  it("counts a valid frame refused by accepts as dropped and does not deliver it", async () => {
    const { client, received } = setup({ accepts: () => false });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();

    sockets[0]?.receive(PRESENCE_FRAME);

    expect(client.droppedMessages).toBe(1);
    expect(received).toEqual([]);
  });

  it("delivers valid server frames and drops and counts the others", async () => {
    const { client, received } = setup();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0];
    socket?.open();

    socket?.receive("not json");
    socket?.receive(JSON.stringify({ type: "unknown.frame" }));
    socket?.receive(42);
    socket?.receive(PRESENCE_FRAME);

    expect(client.droppedMessages).toBe(3);
    expect(received).toEqual([
      expect.objectContaining({ type: "robot.presence", robotId: "robot-01" }),
    ]);
  });

  it("sends a client frame only while the connection is open", async () => {
    const { client } = setup();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0];

    expect(client.send({ type: "ping" })).toBe(false);
    socket?.open();
    expect(client.send({ type: "ping" })).toBe(true);
    expect(socket?.sent).toEqual(['{"type":"ping"}']);
  });
});

describe("subscription hook and keep-alive", () => {
  /**
   * Creates a client that counts its opens.
   *
   * @param onOpen - Spy for the open hook.
   * @returns The client.
   */
  function openingClient(onOpen: () => void) {
    return createWsClient({
      getWsUrl: () => WS_URL,
      fetchToken: () => Promise.resolve(`tok-${String(++tokens)}`),
      onMessage: () => undefined,
      onOpen,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 0.999999,
    });
  }

  it("calls onOpen on every open, and not on connect", async () => {
    const onOpen = vi.fn();
    const client = openingClient(onOpen);

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(onOpen).not.toHaveBeenCalled();

    sockets[0]?.open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    sockets[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]?.open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("sends a ping every keep-alive interval while open", async () => {
    const client = openingClient(() => undefined);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();

    await vi.advanceTimersByTimeAsync(liveTokens.pingIntervalMs);
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "ping" })]);

    await vi.advanceTimersByTimeAsync(liveTokens.pingIntervalMs);
    expect(sockets[0]?.sent).toHaveLength(2);
    client.close();
  });

  it("stops pinging when the connection drops", async () => {
    const client = openingClient(() => undefined);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    sockets[0]?.serverClose();

    await vi.advanceTimersByTimeAsync(liveTokens.pingIntervalMs * 2);
    expect(sockets[0]?.sent).toEqual([]);
    client.close();
  });

  it("stops pinging when the user closes the client", async () => {
    const client = openingClient(() => undefined);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    client.close();

    await vi.advanceTimersByTimeAsync(liveTokens.pingIntervalMs * 2);
    expect(sockets[0]?.sent).toEqual([]);
  });
});
