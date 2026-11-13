/**
 * The WebSocket handlers over in-memory ports: the status each refusal returns, the denied-access rows of the
 * design (section 10.3), and log hygiene. A token presented on `$connect` must appear in no log entry, metric or
 * returned body, also when the store fails.
 */
import type { Context } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

// The handler modules build their production handler at import, so the environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("IOT_DATA_ENDPOINT", "abc123-ats.iot.eu-west-3.amazonaws.com");
  vi.stubEnv("WS_URL", "wss://abc123.execute-api.eu-west-3.amazonaws.com/live");
  vi.stubEnv("WS_ALLOWED_ORIGINS", '["https://console.example"]');
});
import { createWsConnectHandler } from "../../src/handlers/ws-connect";
import { createWsDisconnectHandler } from "../../src/handlers/ws-disconnect";
import { createWsMessageHandler } from "../../src/handlers/ws-message";
import { createWsTokenHandler } from "../../src/handlers/ws-token";
import { commandTopic, CommandSchema, type RobotId } from "@mfc/protocol";
import { HeartbeatLogThrottle } from "../../src/domain/ws/heartbeat";
import type { LockItem } from "../../src/domain/control/ports";
import { issueToken } from "../../src/domain/ws/token";
import { FIXTURE_TOKEN, FakeLockStore, FakePublisher } from "../fakes/control";
import { FixedClock, SequentialIds } from "../fakes/fixed";
import { FakeFleetState, FakePush } from "../fakes/live";
import { RecordingHandlerLogger } from "../fakes/recording";
import { FakeWsSession, RecordingWsMetrics } from "../fakes/ws-session";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const SUB = "00000000-0000-4000-8000-000000000001";
const CONSOLE_ORIGIN = "https://console.example";
const REGION_DOMAIN = "abc123.execute-api.eu-west-3.amazonaws.com";
const CONNECTION_ID = "abcdef12";
const OTHER_SUB = "00000000-0000-4000-8000-000000000002";

/**
 * A Lambda context with the fields the handlers read.
 *
 * @returns The context.
 */
function lambdaContext(): Context {
  return { awsRequestId: "req-0001-abcdef" } as unknown as Context;
}

/**
 * A verified principal of the tests, granted the Paris site.
 *
 * @returns The principal event field.
 */
function principal(): {
  sub: string;
  role: "Operator";
  siteIds: string[];
  sessionExpiresAt: string;
} {
  return {
    sub: SUB,
    role: "Operator",
    siteIds: ["paris-01"],
    sessionExpiresAt: "2026-11-02T10:55:00.000Z",
  };
}

/**
 * A `ws-token` invocation event.
 *
 * @param siteId - The site requested.
 * @returns The event.
 */
function tokenEvent(siteId = "paris-01"): Record<string, unknown> {
  return { principal: principal(), request: { siteId }, correlationId: "corr-0001-abcd" };
}

/**
 * A token handler over fresh fakes.
 *
 * @returns The handler and its fakes.
 */
function tokenSetup(): {
  handler: ReturnType<typeof createWsTokenHandler>;
  store: FakeWsSession;
  logger: RecordingHandlerLogger;
  metrics: RecordingWsMetrics;
} {
  const store = new FakeWsSession();
  const logger = new RecordingHandlerLogger();
  const metrics = new RecordingWsMetrics();
  const handler = createWsTokenHandler({
    store,
    clock: new FixedClock(NOW),
    random: (size) => Buffer.alloc(size, 9),
    url: `wss://${REGION_DOMAIN}/live`,
    logger,
    metrics,
  });
  return { handler, store, logger, metrics };
}

describe("ws-token handler", () => {
  it("issues a token, returns it with the URL, and never logs it", async () => {
    const { handler, logger, metrics } = tokenSetup();
    const result = await handler(tokenEvent(), lambdaContext());

    expect(result.statusCode).toBe(200);
    if (result.statusCode !== 200) {
      throw new Error("expected a token");
    }
    expect(result.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.body.url).toBe(`wss://${REGION_DOMAIN}/live`);
    expect(logger.text()).not.toContain(result.body.token);
    expect(metrics.counted).toStrictEqual(["WsTokenIssued"]);
    expect(metrics.published).toBe(1);
  });

  it("answers an invalid event with 400 and a problem that echoes the request id", async () => {
    const { handler } = tokenSetup();
    const result = await handler({ ...tokenEvent(), extra: true }, lambdaContext());
    expect(result).toMatchObject({
      statusCode: 400,
      body: {
        type: "urn:mfc:problem:invalid-request",
        status: 400,
        correlationId: "req-0001-abcdef",
      },
    });
  });

  it("denies a site the principal does not hold, with 403, and stores nothing (denied-access)", async () => {
    const { handler, store, metrics } = tokenSetup();
    const result = await handler(tokenEvent("lyon-02"), lambdaContext());
    expect(result).toMatchObject({
      statusCode: 403,
      body: {
        type: "urn:mfc:problem:forbidden-site",
        status: 403,
        correlationId: "corr-0001-abcd",
      },
    });
    expect(store.calls).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["WsTokenRefused"]);
  });

  it("refuses a session window outside the allowed range with 400", async () => {
    const { handler } = tokenSetup();
    const event = {
      ...tokenEvent(),
      principal: { ...principal(), sessionExpiresAt: "2026-11-02T09:00:00.000Z" },
    };
    const result = await handler(event, lambdaContext());
    expect(result).toMatchObject({
      statusCode: 400,
      body: { type: "urn:mfc:problem:invalid-session" },
    });
  });

  it("answers a store failure with 500 and a body that carries no internal detail", async () => {
    const { handler, store, logger } = tokenSetup();
    store.failure = new Error("arn:aws:dynamodb:eu-west-3:123456789012:table/secret-detail");
    const result = await handler(tokenEvent(), lambdaContext());
    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("123456789012");
    expect(logger.text()).not.toContain("123456789012");
    expect(
      logger.entries.find((entry) => entry.message === "token request failed")?.attributes,
    ).toStrictEqual({
      errorName: "Error",
    });
  });
});

describe("ws-connect handler", () => {
  /**
   * A `$connect` proxy event.
   *
   * @param token - The token in the query string, or undefined for none.
   * @param headers - The request headers.
   * @returns The event.
   */
  function connectEvent(
    token: string | undefined,
    headers: Record<string, string> = { Origin: CONSOLE_ORIGIN },
  ): Record<string, unknown> {
    return {
      requestContext: { connectionId: CONNECTION_ID },
      queryStringParameters: token === undefined ? null : { token },
      headers,
    };
  }

  /**
   * A connect handler over fresh fakes.
   *
   * @returns The handler and its fakes.
   */
  function connectSetup(): {
    handler: ReturnType<typeof createWsConnectHandler>;
    store: FakeWsSession;
    logger: RecordingHandlerLogger;
    metrics: RecordingWsMetrics;
  } {
    const store = new FakeWsSession();
    const logger = new RecordingHandlerLogger();
    const metrics = new RecordingWsMetrics();
    const handler = createWsConnectHandler({
      store,
      clock: new FixedClock(NOW),
      allowedOrigins: [CONSOLE_ORIGIN],
      logger,
      metrics,
    });
    return { handler, store, logger, metrics };
  }

  /**
   * Stores a token of the tests, as the token endpoint would.
   *
   * @param store - The store.
   * @returns The token.
   */
  async function storeToken(store: FakeWsSession): Promise<string> {
    const response = await issueToken(
      principal(),
      { siteId: "paris-01" },
      {
        store,
        clock: new FixedClock(NOW),
        random: (size) => Buffer.alloc(size, 9),
        url: `wss://${REGION_DOMAIN}/live`,
      },
    );
    return response.token;
  }

  it("accepts a valid token from the console origin, read whatever the case of the header name", async () => {
    const { handler, store, metrics } = connectSetup();
    const token = await storeToken(store);
    const result = await handler(connectEvent(token, { origin: CONSOLE_ORIGIN }), lambdaContext());
    expect(result).toStrictEqual({ statusCode: 200 });
    expect(store.connections.get(CONNECTION_ID)?.siteId).toBe("paris-01");
    expect(metrics.counted).toStrictEqual(["WsConnected"]);
  });

  it("refuses a connection without a token, with 401 and no record written (denied-access)", async () => {
    const { handler, store } = connectSetup();
    expect(await handler(connectEvent(undefined), lambdaContext())).toStrictEqual({
      statusCode: 401,
    });
    expect(store.connections.size).toBe(0);
  });

  it("refuses a 42-character token with 401 and no record written (denied-access)", async () => {
    const { handler, store } = connectSetup();
    expect(await handler(connectEvent("A".repeat(42)), lambdaContext())).toStrictEqual({
      statusCode: 401,
    });
    expect(store.connections.size).toBe(0);
  });

  it("refuses a reused token with 401 (denied-access)", async () => {
    const { handler, store } = connectSetup();
    const token = await storeToken(store);
    expect(await handler(connectEvent(token), lambdaContext())).toStrictEqual({ statusCode: 200 });
    const reused = await handler(connectEvent(token), lambdaContext());
    expect(reused).toStrictEqual({ statusCode: 401 });
    expect(store.connections.size).toBe(1);
  });

  it("refuses an expired token with 401 and no record written (denied-access)", async () => {
    const store = new FakeWsSession();
    const clock = new FixedClock(NOW);
    const logger = new RecordingHandlerLogger();
    const handler = createWsConnectHandler({
      store,
      clock,
      allowedOrigins: [CONSOLE_ORIGIN],
      logger,
      metrics: new RecordingWsMetrics(),
    });
    const token = await storeToken(store);
    clock.advance(61_000);
    expect(await handler(connectEvent(token), lambdaContext())).toStrictEqual({ statusCode: 401 });
    expect(store.connections.size).toBe(0);
  });

  it("refuses a foreign origin with 403 and no record written (denied-access)", async () => {
    const { handler, store } = connectSetup();
    const token = await storeToken(store);
    const result = await handler(
      connectEvent(token, { Origin: "https://evil.example" }),
      lambdaContext(),
    );
    expect(result).toStrictEqual({ statusCode: 403 });
    expect(store.connections.size).toBe(0);
  });

  it("answers an unreadable event with 400", async () => {
    const { handler, store } = connectSetup();
    expect(await handler({ requestContext: {} }, lambdaContext())).toStrictEqual({
      statusCode: 400,
    });
    expect(store.calls).toStrictEqual([]);
  });

  it("answers a store failure with 500 and logs no token, also when the store throws", async () => {
    const { handler, store, logger } = connectSetup();
    const token = await storeToken(store);
    store.failure = new Error(`store said ${token}`);
    const result = await handler(connectEvent(token), lambdaContext());
    expect(result).toStrictEqual({ statusCode: 500 });
    expect(logger.text()).not.toContain(token);
  });

  it("never logs the token of a successful or refused connection", async () => {
    const { handler, store, logger } = connectSetup();
    const token = await storeToken(store);
    await handler(connectEvent(token, { Origin: "https://evil.example" }), lambdaContext());
    await handler(connectEvent(token), lambdaContext());
    await handler(connectEvent(token), lambdaContext());
    expect(logger.text()).not.toContain(token);
  });
});

describe("ws-disconnect handler", () => {
  it("removes the record and answers 200, also when there is none", async () => {
    const store = new FakeWsSession();
    const handler = createWsDisconnectHandler({
      store,
      logger: new RecordingHandlerLogger(),
      metrics: new RecordingWsMetrics(),
    });
    expect(
      await handler({ requestContext: { connectionId: CONNECTION_ID } }, lambdaContext()),
    ).toStrictEqual({
      statusCode: 200,
    });
    expect(store.removed).toStrictEqual([CONNECTION_ID]);
  });

  it("answers an unreadable event with 400", async () => {
    const handler = createWsDisconnectHandler({
      store: new FakeWsSession(),
      logger: new RecordingHandlerLogger(),
      metrics: new RecordingWsMetrics(),
    });
    expect(await handler({}, lambdaContext())).toStrictEqual({ statusCode: 400 });
  });

  it("rethrows a store failure, so the record expires by its TTL", async () => {
    const store = new FakeWsSession();
    store.failure = new Error("throttled");
    const handler = createWsDisconnectHandler({
      store,
      logger: new RecordingHandlerLogger(),
      metrics: new RecordingWsMetrics(),
    });
    await expect(
      handler({ requestContext: { connectionId: CONNECTION_ID } }, lambdaContext()),
    ).rejects.toThrow("throttled");
  });
});

describe("ws-message handler", () => {
  /**
   * A `$default` proxy event.
   *
   * @param body - The frame text.
   * @param domainName - The domain name of the stage.
   * @returns The event.
   */
  function messageEvent(body: string | null, domainName = REGION_DOMAIN): Record<string, unknown> {
    return { body, requestContext: { connectionId: CONNECTION_ID, domainName, stage: "live" } };
  }

  /**
   * A message handler over fresh fakes, with the push of every endpoint recorded.
   *
   * @returns The handler, its fakes and the endpoints it pushed to.
   */
  function messageSetup(): {
    handler: ReturnType<typeof createWsMessageHandler>;
    store: FakeWsSession;
    push: FakePush;
    endpoints: string[];
    logger: RecordingHandlerLogger;
    locks: FakeLockStore;
    publisher: FakePublisher;
    metrics: RecordingWsMetrics;
    calls: string[];
  } {
    const store = new FakeWsSession();
    const push = new FakePush();
    const endpoints: string[] = [];
    const logger = new RecordingHandlerLogger();
    const calls: string[] = [];
    const locks = new FakeLockStore(calls);
    const publisher = new FakePublisher(calls);
    const metrics = new RecordingWsMetrics();
    store.connections.set(CONNECTION_ID, {
      connectionId: CONNECTION_ID,
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      connectedAtMs: NOW.getTime(),
      sessionExpiresAtMs: NOW.getTime() + 3_600_000,
      subscribed: false,
    });
    const handler = createWsMessageHandler({
      store,
      fleet: new FakeFleetState(),
      clock: new FixedClock(NOW),
      logger,
      metrics,
      region: "eu-west-3",
      pushFor: (endpoint) => {
        endpoints.push(endpoint);
        return push;
      },
      locks,
      publisher,
      ids: new SequentialIds(),
      logThrottle: new HeartbeatLogThrottle(),
    });
    return { handler, store, push, endpoints, logger, locks, publisher, metrics, calls };
  }

  /**
   * A live lock of a robot, held by a subject, with the fixture token.
   *
   * @param holder - Subject of the holder.
   * @param robotId - The robot of the lock.
   * @returns The lock item.
   */
  function liveLock(holder: string, robotId: RobotId = "sim-01"): LockItem {
    return {
      robotId,
      holder,
      token: FIXTURE_TOKEN,
      acquiredAt: NOW.toISOString(),
      expiresAt: Math.floor(NOW.getTime() / 1000) + 30,
    };
  }

  /** A heartbeat frame of a robot. */
  const HEARTBEAT_FRAME = JSON.stringify({ type: "heartbeat", robotId: "sim-01" });

  it("derives the management endpoint from the request context and answers 200", async () => {
    const { handler, push, endpoints } = messageSetup();
    expect(
      await handler(messageEvent(JSON.stringify({ type: "ping" })), lambdaContext()),
    ).toStrictEqual({
      statusCode: 200,
    });
    expect(endpoints).toStrictEqual([`https://${REGION_DOMAIN}/live`]);
    expect(push.posted).toStrictEqual([]);
  });

  it("answers an invalid frame with an error frame and still 200", async () => {
    const { handler, push } = messageSetup();
    expect(await handler(messageEvent("{}"), lambdaContext())).toStrictEqual({ statusCode: 200 });
    expect(push.frames()).toStrictEqual([{ type: "error", code: "INVALID_MESSAGE" }]);
  });

  it("refuses a request context of another region by throwing, and pushes nothing", async () => {
    const { handler, endpoints } = messageSetup();
    await expect(
      handler(
        messageEvent(
          JSON.stringify({ type: "ping" }),
          "abc123.execute-api.eu-west-1.amazonaws.com",
        ),
        lambdaContext(),
      ),
    ).rejects.toThrow("message handling failed");
    expect(endpoints).toStrictEqual([]);
  });

  it("refuses an event of another shape by throwing, with a generic error", async () => {
    const { handler, logger } = messageSetup();
    await expect(handler({ body: "{}" }, lambdaContext())).rejects.toThrow(
      "message handling failed",
    );
    expect(logger.entries.at(-1)).toMatchObject({
      level: "error",
      message: "message handling failed",
    });
  });

  it("refuses a heartbeat from a Viewer with an error frame, not a failure (denied-access)", async () => {
    const { handler, store, push } = messageSetup();
    const record = store.connections.get(CONNECTION_ID);
    if (record !== undefined) {
      store.connections.set(CONNECTION_ID, { ...record, role: "Viewer" });
    }
    expect(
      await handler(
        messageEvent(JSON.stringify({ type: "heartbeat", robotId: "sim-01" })),
        lambdaContext(),
      ),
    ).toStrictEqual({ statusCode: 200 });
    expect(push.frames()).toStrictEqual([{ type: "error", code: "FORBIDDEN_ROLE" }]);
  });

  it("refuses a subscription to another site with an error frame (denied-access)", async () => {
    const { handler, push, logger } = messageSetup();
    await handler(
      messageEvent(JSON.stringify({ type: "subscribe", siteId: "lyon-02" })),
      lambdaContext(),
    );
    expect(push.frames()).toStrictEqual([{ type: "error", code: "FORBIDDEN_SITE" }]);
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("throws a generic error on an infrastructure failure, so API Gateway answers with an error", async () => {
    const { handler, store, logger } = messageSetup();
    store.failure = new Error("throttled");
    const failure = handler(messageEvent(JSON.stringify({ type: "ping" })), lambdaContext());
    await expect(failure).rejects.toThrow("message handling failed");
    await expect(failure).rejects.not.toThrow("throttled");
    expect(logger.entries.at(-1)).toMatchObject({
      level: "error",
      attributes: { errorName: "Error" },
    });
  });

  it("never logs the frame body", async () => {
    const { handler, logger } = messageSetup();
    await handler(
      messageEvent(JSON.stringify({ type: "ping", note: "SECRET-BODY" })),
      lambdaContext(),
    );
    await handler(messageEvent('{"type":"subscribe","siteId":"SECRET-BODY"}'), lambdaContext());
    expect(logger.text()).not.toContain("SECRET-BODY");
  });

  it("publishes one HEARTBEAT for the verified holder of a live lock, and answers nothing", async () => {
    const { handler, locks, publisher, push, metrics } = messageSetup();
    locks.put(liveLock(SUB));
    expect(await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext())).toStrictEqual({
      statusCode: 200,
    });
    const entry = publisher.published.at(0);
    if (entry === undefined) {
      throw new Error("expected one heartbeat publish");
    }
    expect(publisher.published).toHaveLength(1);
    expect(entry.topic).toBe(commandTopic("paris-01", "sim-01"));
    expect(CommandSchema.parse(JSON.parse(entry.payload))).toMatchObject({
      type: "HEARTBEAT",
      robotId: "sim-01",
      siteId: "paris-01",
      issuedBy: SUB,
      lockToken: FIXTURE_TOKEN,
    });
    expect(push.posted).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["HeartbeatPublished"]);
  });

  it("refuses a heartbeat from a Viewer with an error frame, before any lock read (denied-access)", async () => {
    const { handler, store, locks, publisher, push, calls } = messageSetup();
    const record = store.connections.get(CONNECTION_ID);
    if (record !== undefined) {
      store.connections.set(CONNECTION_ID, { ...record, role: "Viewer" });
    }
    locks.put(liveLock(SUB));
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    expect(push.frames()).toStrictEqual([{ type: "error", code: "FORBIDDEN_ROLE" }]);
    expect(publisher.published).toStrictEqual([]);
    expect(calls).not.toContain("locks.get");
  });

  it("refuses a heartbeat from a connection that is not the holder, silently (denied-access)", async () => {
    const { handler, locks, publisher, push, metrics } = messageSetup();
    locks.put(liveLock(OTHER_SUB));
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    expect(push.posted).toStrictEqual([]);
    expect(publisher.published).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["HeartbeatRefused"]);
  });

  it("refuses a heartbeat once the lock of the holder expired, silently (denied-access)", async () => {
    const { handler, locks, publisher, push, metrics } = messageSetup();
    locks.put({ ...liveLock(SUB), expiresAt: Math.floor(NOW.getTime() / 1000) });
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    expect(push.posted).toStrictEqual([]);
    expect(publisher.published).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["HeartbeatRefused"]);
  });

  it("refuses a heartbeat for a robot whose lock another robot holds, silently (denied-access)", async () => {
    const { handler, locks, publisher, push, metrics } = messageSetup();
    locks.put(liveLock(SUB, "sim-02"));
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    expect(push.posted).toStrictEqual([]);
    expect(publisher.published).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["HeartbeatRefused"]);
  });

  it("closes a connection whose session ended, and publishes nothing (denied-access)", async () => {
    const { handler, store, locks, publisher, push, calls } = messageSetup();
    const record = store.connections.get(CONNECTION_ID);
    if (record !== undefined) {
      store.connections.set(CONNECTION_ID, { ...record, sessionExpiresAtMs: NOW.getTime() });
    }
    locks.put(liveLock(SUB));
    expect(await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext())).toStrictEqual({
      statusCode: 200,
    });
    expect(push.closed).toStrictEqual([CONNECTION_ID]);
    expect(publisher.published).toStrictEqual([]);
    expect(calls).not.toContain("locks.get");
  });

  it("answers a publish failure with no frame and no throw, and counts it", async () => {
    const { handler, locks, publisher, push, metrics } = messageSetup();
    locks.put(liveLock(SUB));
    publisher.failure = new Error("publish refused");
    expect(await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext())).toStrictEqual({
      statusCode: 200,
    });
    expect(push.posted).toStrictEqual([]);
    expect(metrics.counted).toStrictEqual(["HeartbeatPublishFailed"]);
  });

  it("keeps the lock token out of every frame and log entry, on publish, refusal and failure", async () => {
    const { handler, locks, publisher, push, logger } = messageSetup();
    locks.put(liveLock(SUB));
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    publisher.failure = new Error("publish refused");
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    locks.put(liveLock(OTHER_SUB));
    await handler(messageEvent(HEARTBEAT_FRAME), lambdaContext());
    expect(JSON.stringify(push.posted) + logger.text()).not.toContain(FIXTURE_TOKEN);
  });
});
