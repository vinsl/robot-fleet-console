/**
 * Tests of the single-use token: issue, storage by hash, redemption at `$connect`, and the refusals that
 * come before any store call. Each denied-access row of the design (section 10.3, item 1) is named here.
 */
import type { Principal } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  WsDenied,
  hashToken,
  issueToken,
  newToken,
  redeemAndConnect,
  tokenExpiresAtSeconds,
  type ConnectDeps,
  type IssueDeps,
} from "../../../src/domain/ws/token";
import { FixedClock } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";
import { FakeWsSession } from "../../fakes/ws-session";

/** Fixed instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");
/** Subject of the principal. */
const SUB = "00000000-0000-4000-8000-000000000001";
/** The one allowed browser origin. */
const CONSOLE_ORIGIN = "https://console.example";
/** The WebSocket URL of the stage. */
const URL = "wss://abc123.execute-api.eu-west-3.amazonaws.com/live";

/** A principal granted the Paris site, with a session that ends in 55 minutes. */
function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: SUB,
    role: "Operator",
    siteIds: ["paris-01"],
    sessionExpiresAt: "2026-11-02T10:55:00.000Z",
    ...overrides,
  };
}

/**
 * A deterministic entropy source: each call returns the next byte value, so two tokens differ.
 *
 * @returns The source.
 */
function counterRandom(): (size: number) => Buffer {
  let next = 1;
  return (size) => Buffer.alloc(size, next++);
}

/**
 * Builds the issue dependencies over a fresh store.
 *
 * @returns The dependencies and the store they write to.
 */
function issueSetup(): { deps: IssueDeps; store: FakeWsSession; clock: FixedClock } {
  const store = new FakeWsSession();
  const clock = new FixedClock(NOW);
  return { deps: { store, clock, random: counterRandom(), url: URL }, store, clock };
}

/**
 * Builds the connect dependencies over a store, with the console origin allowed.
 *
 * @param store - The store.
 * @param clock - The clock.
 * @returns The dependencies and the logger they write to.
 */
function connectSetup(
  store: FakeWsSession,
  clock: FixedClock,
): { deps: ConnectDeps; logger: RecordingLogger } {
  const logger = new RecordingLogger();
  return { deps: { store, clock, allowedOrigins: [CONSOLE_ORIGIN], logger }, logger };
}

describe("hashToken", () => {
  it("is the SHA-256 hex digest of the token, so the token itself is never stored", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("newToken", () => {
  it("encodes 32 random bytes as 43 url-safe characters without padding", () => {
    const token = newToken(() => Buffer.alloc(32, 0xff));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses an entropy source that returns the wrong number of bytes", () => {
    expect(() => newToken(() => Buffer.alloc(16, 1))).toThrow("wrong length");
  });
});

describe("tokenExpiresAtSeconds", () => {
  it("is the expiry in epoch seconds, rounded up, plus a 60 second grace period", () => {
    expect(tokenExpiresAtSeconds(1_000_500)).toBe(1061);
  });
});

describe("issueToken", () => {
  it("refuses a site the principal does not hold, and stores nothing", async () => {
    const { deps, store } = issueSetup();
    const attempt = issueToken(principal(), { siteId: "lyon-02" }, deps);
    await expect(attempt).rejects.toMatchObject({ name: "WsDenied", code: "FORBIDDEN_SITE" });
    expect(store.calls).toStrictEqual([]);
  });

  it("refuses a session that already ended", async () => {
    const { deps, store } = issueSetup();
    const attempt = issueToken(
      principal({ sessionExpiresAt: "2026-11-02T09:59:59.000Z" }),
      { siteId: "paris-01" },
      deps,
    );
    await expect(attempt).rejects.toBeInstanceOf(WsDenied);
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(store.calls).toStrictEqual([]);
  });

  it("refuses a session that lasts more than one hour", async () => {
    const { deps, store } = issueSetup();
    const attempt = issueToken(
      principal({ sessionExpiresAt: "2026-11-02T11:00:00.001Z" }),
      { siteId: "paris-01" },
      deps,
    );
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(store.calls).toStrictEqual([]);
  });

  it("issues a 43-character token, stores only its hash, valid for 60 seconds and bound to the principal", async () => {
    const { deps, store } = issueSetup();
    const response = await issueToken(principal(), { siteId: "paris-01" }, deps);

    expect(response.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.url).toBe(URL);
    expect(response.expiresAt).toBe("2026-11-02T10:01:00.000Z");
    expect(response.sessionExpiresAt).toBe("2026-11-02T10:55:00.000Z");
    const stored = store.tokens.get(hashToken(response.token));
    expect(stored).toStrictEqual({
      tokenHash: hashToken(response.token),
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      sessionExpiresAtMs: Date.parse("2026-11-02T10:55:00.000Z"),
      expiresAtMs: Date.parse("2026-11-02T10:01:00.000Z"),
    });
    expect([...store.tokens.keys()]).not.toContain(response.token);
  });

  it("issues two different tokens for two requests", async () => {
    const { deps } = issueSetup();
    const first = await issueToken(principal(), { siteId: "paris-01" }, deps);
    const second = await issueToken(principal(), { siteId: "paris-01" }, deps);
    expect(first.token).not.toBe(second.token);
  });
});

describe("redeemAndConnect", () => {
  /**
   * Issues a token for the Paris site with the given store, and returns it.
   *
   * @param store - The store.
   * @param clock - The clock.
   * @returns The token.
   */
  async function issued(store: FakeWsSession, clock: FixedClock): Promise<string> {
    const response = await issueToken(
      principal(),
      { siteId: "paris-01" },
      {
        store,
        clock,
        random: counterRandom(),
        url: URL,
      },
    );
    return response.token;
  }

  it("accepts a token once: the first redemption connects, the second is refused", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = await issued(store, clock);

    const first = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    const second = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0002" },
      deps,
    );

    expect(first).toStrictEqual({ statusCode: 200 });
    expect(second).toStrictEqual({ statusCode: 401 });
    expect(store.connections.get("conn-0001")).toStrictEqual({
      connectionId: "conn-0001",
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      connectedAtMs: NOW.getTime(),
      sessionExpiresAtMs: Date.parse("2026-11-02T10:55:00.000Z"),
      subscribed: false,
    });
    expect(store.connections.has("conn-0002")).toBe(false);
  });

  it("refuses a token older than 60 seconds", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = await issued(store, clock);
    clock.advance(61_000);

    const result = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    expect(result).toStrictEqual({ statusCode: 401 });
    expect(store.connections.size).toBe(0);
  });

  it.each([
    ["a 42-character token", "A".repeat(42)],
    ["a 44-character token", "A".repeat(44)],
    ["a path traversal", "../../etc/passwd" + "A".repeat(26)],
    ["a non-ASCII token", "é".repeat(43)],
    ["a number", 123],
    ["a missing token", undefined],
  ])("refuses %s with 401 and without any store call", async (_label, token) => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);

    const result = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    expect(result).toStrictEqual({ statusCode: 401 });
    expect(store.calls).toStrictEqual([]);
  });

  it("refuses a foreign origin with 403, and does not consume the token", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = await issued(store, clock);
    store.calls.splice(0, store.calls.length);

    const foreign = await redeemAndConnect(
      { token, origin: "https://evil.example", connectionId: "conn-0001" },
      deps,
    );
    expect(foreign).toStrictEqual({ statusCode: 403 });
    expect(store.calls).toStrictEqual([]);

    const retry = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    expect(retry).toStrictEqual({ statusCode: 200 });
  });

  it("accepts a request with no origin, because the token still decides", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = await issued(store, clock);

    const result = await redeemAndConnect(
      { token, origin: undefined, connectionId: "conn-0001" },
      deps,
    );
    expect(result).toStrictEqual({ statusCode: 200 });
  });

  it("returns 500 and logs only the error name when the store fails, never the token", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps, logger } = connectSetup(store, clock);
    const token = await issued(store, clock);
    store.failure = Object.assign(new Error(`throttled ${token}`), {
      name: "ProvisionedThroughputExceededException",
    });

    const result = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );

    expect(result).toStrictEqual({ statusCode: 500 });
    expect(logger.entries).toStrictEqual([
      {
        level: "error",
        message: "connection record failed",
        attributes: { errorName: "ProvisionedThroughputExceededException" },
      },
    ]);
    expect(logger.text()).not.toContain(token);
  });

  it("consumes the token and returns 500 when the connection record cannot be stored (fail closed)", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = await issued(store, clock);
    store.putConnection = () => Promise.reject(new Error("write refused"));

    const result = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    expect(result).toStrictEqual({ statusCode: 500 });
    expect(store.tokens.size).toBe(0);
  });

  it("refuses a token whose session ended before the redemption, even inside its TTL", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const { deps } = connectSetup(store, clock);
    const token = "A".repeat(43);
    await store.putToken({
      tokenHash: hashToken(token),
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      sessionExpiresAtMs: NOW.getTime() - 1,
      expiresAtMs: NOW.getTime() + 60_000,
    });

    const result = await redeemAndConnect(
      { token, origin: CONSOLE_ORIGIN, connectionId: "conn-0001" },
      deps,
    );
    expect(result).toStrictEqual({ statusCode: 401 });
    expect(store.connections.size).toBe(0);
  });
});
