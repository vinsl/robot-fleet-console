/**
 * Tests of the client frame rules: size and schema before any effect, the connection and session checks,
 * the subscribe site rule (design section 10.3, items 2 and 3), and the frames sent back.
 */
import type { RobotLiveState, WsServerMessage } from "@mfc/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleClientMessage, type ClientMessageDeps } from "../../../src/domain/ws/dispatch";
import { HeartbeatLogThrottle } from "../../../src/domain/ws/heartbeat";
import type { ConnectionRecord } from "../../../src/domain/ws/session";
import { FakeLockStore, FakePublisher } from "../../fakes/control";
import { BOOT_A, FakeFleetState, FakePush } from "../../fakes/live";
import { FixedClock, SequentialIds } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";
import { FakeWsSession, RecordingWsMetrics } from "../../fakes/ws-session";

/** Fixed instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");
/** The connection of the tests. */
const CONNECTION_ID = "abcdef12";
/** The site of the connection. */
const SITE = "paris-01";

/**
 * A connection record of the given role, open for one hour.
 *
 * @param overrides - Fields to change.
 * @returns The record.
 */
function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: CONNECTION_ID,
    sub: "00000000-0000-4000-8000-000000000001",
    role: "Operator",
    siteId: SITE,
    connectedAtMs: NOW.getTime(),
    sessionExpiresAtMs: NOW.getTime() + 60 * 60 * 1000,
    subscribed: false,
    ...overrides,
  };
}

/**
 * A live state of a robot, as the fleet listing returns it.
 *
 * @param robotId - The robot.
 * @returns The state.
 */
function liveState(robotId: string): RobotLiveState {
  return {
    robotId,
    siteId: SITE,
    state: "IDLE",
    battery: 80,
    bootId: BOOT_A,
    seq: 1,
    ts: "2026-11-02T10:00:00.000Z",
    receivedAt: NOW.getTime(),
  };
}

/** A complete set of fakes for one test. */
interface Harness {
  readonly deps: ClientMessageDeps;
  readonly store: FakeWsSession;
  readonly fleet: FakeFleetState;
  readonly push: FakePush;
  readonly logger: RecordingLogger;
  readonly metrics: RecordingWsMetrics;
}

/**
 * Builds the fakes, with one open connection unless told otherwise.
 *
 * @param record - The stored connection, or null for none.
 * @returns The harness.
 */
function harness(record: ConnectionRecord | null = connection()): Harness {
  const store = new FakeWsSession();
  if (record !== null) {
    store.connections.set(record.connectionId, record);
  }
  const fleet = new FakeFleetState();
  const push = new FakePush();
  const logger = new RecordingLogger();
  const metrics = new RecordingWsMetrics();
  const clock = new FixedClock(NOW);
  const calls: string[] = [];
  const deps: ClientMessageDeps = {
    store,
    fleet,
    push,
    clock,
    logger,
    metrics,
    heartbeat: {
      locks: new FakeLockStore(calls),
      publisher: new FakePublisher(calls),
      clock,
      ids: new SequentialIds(),
      logger,
      metrics,
      logThrottle: new HeartbeatLogThrottle(),
    },
  };
  return {
    deps,
    store,
    fleet,
    push,
    logger,
    metrics,
  };
}

/**
 * Sends one frame of text from the given connection.
 *
 * @param h - The harness.
 * @param body - The frame text, or an absent body.
 */
function send(h: Harness, body: string | null | undefined): Promise<void> {
  return handleClientMessage({ body, connectionId: CONNECTION_ID }, h.deps);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleClientMessage: size and schema", () => {
  it.each([
    ["an absent body", undefined],
    ["a null body", null],
  ])("answers %s with INVALID_MESSAGE, once the connection is read", async (_label, body) => {
    const h = harness();
    await send(h, body);
    expect(h.push.frames()).toStrictEqual([{ type: "error", code: "INVALID_MESSAGE" }]);
    expect(h.store.calls).toStrictEqual(["getConnection", "countFrame"]);
  });

  it("gives no reply to a frame of an unknown connection, and does not read its body", async () => {
    const h = harness(null);
    const parse = vi.spyOn(JSON, "parse");
    await send(h, "{SECRET-MARK");
    expect(parse).not.toHaveBeenCalled();
    expect(h.push.posted).toStrictEqual([]);
    expect(h.push.closed).toStrictEqual([CONNECTION_ID]);
  });

  it("refuses a frame over 2 048 bytes without parsing it", async () => {
    const h = harness();
    const parse = vi.spyOn(JSON, "parse");
    await send(h, "x".repeat(2049));
    expect(parse).not.toHaveBeenCalled();
    expect(h.push.frames()).toStrictEqual([{ type: "error", code: "INVALID_MESSAGE" }]);
  });

  it.each([
    ["not JSON", "{SECRET-MARK"],
    ["an unknown type", JSON.stringify({ type: "shutdown", note: "SECRET-MARK" })],
    ["a subscribe without a site", JSON.stringify({ type: "subscribe", note: "SECRET-MARK" })],
    ["an extra key", JSON.stringify({ type: "ping", extra: "SECRET-MARK" })],
    ["a JSON array", '["SECRET-MARK"]'],
  ])("answers %s with INVALID_MESSAGE, without echoing the input", async (_label, body) => {
    const h = harness();
    await send(h, body);
    expect(h.push.frames()).toStrictEqual([{ type: "error", code: "INVALID_MESSAGE" }]);
    expect(h.logger.text()).not.toContain("SECRET-MARK");
    expect(JSON.stringify(h.push.frames())).not.toContain("SECRET-MARK");
  });
});

describe("handleClientMessage: connection and session", () => {
  it("closes a frame whose connection record no longer exists", async () => {
    const h = harness(null);
    await send(h, JSON.stringify({ type: "ping" }));
    expect(h.push.closed).toStrictEqual([CONNECTION_ID]);
    expect(h.push.posted).toStrictEqual([]);
    expect(h.metrics.counted).toStrictEqual(["WsConnectionUnknown"]);
  });

  it("closes an expired session without a reply, and removes its record", async () => {
    const h = harness(connection({ sessionExpiresAtMs: NOW.getTime() }));
    await send(h, JSON.stringify({ type: "ping" }));
    expect(h.push.posted).toStrictEqual([]);
    expect(h.push.closed).toStrictEqual([CONNECTION_ID]);
    expect(h.store.removed).toStrictEqual([CONNECTION_ID]);
    expect(h.metrics.counted).toStrictEqual(["WsSessionEnded"]);
  });

  it("closes a connection over its frame rate, removes its record, and sends nothing", async () => {
    const h = harness();
    h.store.frameAllowed = false;
    await send(h, JSON.stringify({ type: "ping" }));
    expect(h.push.posted).toStrictEqual([]);
    expect(h.push.closed).toStrictEqual([CONNECTION_ID]);
    expect(h.store.removed).toStrictEqual([CONNECTION_ID]);
    expect(h.metrics.counted).toStrictEqual(["WsRateLimited"]);
    expect(h.store.calls).not.toContain("subscribe");
  });

  it("propagates an infrastructure failure of the connection read", async () => {
    const h = harness();
    h.store.failure = new Error("throttled");
    await expect(send(h, JSON.stringify({ type: "ping" }))).rejects.toThrow("throttled");
  });

  it("removes the record when the client is gone (GONE on an error frame)", async () => {
    const h = harness(connection({ role: "Viewer" }));
    h.push.script(CONNECTION_ID, "GONE");
    await send(h, JSON.stringify({ type: "heartbeat", robotId: "sim-01" }));
    expect(h.store.removed).toStrictEqual([CONNECTION_ID]);
  });

  it("counts a failed push without retrying it", async () => {
    const h = harness(connection({ role: "Viewer" }));
    h.push.script(CONNECTION_ID, "FAILED");
    await send(h, JSON.stringify({ type: "heartbeat", robotId: "sim-01" }));
    expect(h.metrics.counted).toStrictEqual(["WsMessageRefused", "WsPushFailed"]);
    expect(h.push.posted).toHaveLength(1);
  });
});

describe("handleClientMessage: subscribe", () => {
  it("refuses a subscription to another site and audits it with a warning and no payload", async () => {
    const h = harness();
    await send(h, JSON.stringify({ type: "subscribe", siteId: "lyon-02" }));

    expect(h.store.calls).not.toContain("subscribe");
    expect(h.push.frames()).toStrictEqual([{ type: "error", code: "FORBIDDEN_SITE" }]);
    expect(h.logger.entries).toStrictEqual([
      {
        level: "warn",
        message: "client message refused",
        attributes: { reason: "FORBIDDEN_SITE" },
      },
    ]);
    expect(h.logger.text()).not.toContain("lyon-02");
  });

  it("subscribes, then sends one snapshot with the robots of the site", async () => {
    const h = harness();
    h.fleet.listed = [liveState("sim-01"), liveState("sim-02")];
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));

    expect(h.store.subscribedTo.get(CONNECTION_ID)).toBe(SITE);
    const frames = h.push.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "fleet.snapshot",
      siteId: SITE,
      robots: [{ robotId: "sim-01" }, { robotId: "sim-02" }],
    });
    expect(h.metrics.counted).toStrictEqual(["WsSubscribed"]);
  });

  it("sends an empty snapshot for a site with no robot, so the client knows it is complete", async () => {
    const h = harness();
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    expect(h.push.frames()).toStrictEqual([
      { type: "fleet.snapshot", siteId: SITE, sentAt: NOW.toISOString(), robots: [] },
    ]);
  });

  it("splits a large fleet into snapshot frames of at most 60 robots", async () => {
    const h = harness();
    h.fleet.listed = Array.from({ length: 130 }, (_value, index) =>
      liveState(`sim-${String(index + 1).padStart(3, "0")}`),
    );
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    const sizes = h.push
      .frames()
      .map((frame) => (frame.type === "fleet.snapshot" ? frame.robots.length : -1));
    expect(sizes).toStrictEqual([60, 60, 10]);
  });

  it("ignores a repeated subscribe, so the fleet is sent once per connection", async () => {
    const h = harness(connection({ subscribed: true }));
    h.fleet.listed = [liveState("sim-01")];
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    expect(h.push.posted).toStrictEqual([]);
    expect(h.store.calls).toStrictEqual(["getConnection", "countFrame"]);
  });

  it("answers a failed listing with SNAPSHOT_FAILED and keeps the subscription", async () => {
    const h = harness();
    h.fleet.listSite = () => Promise.reject(new Error("throttled"));
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    expect(h.store.subscribedTo.get(CONNECTION_ID)).toBe(SITE);
    expect(h.push.frames()).toStrictEqual([{ type: "error", code: "SNAPSHOT_FAILED" }]);
    expect(h.metrics.counted).toStrictEqual(["WsSnapshotFailed"]);
    expect(h.logger.text()).not.toContain("throttled");
  });

  it("closes the connection when its record vanished between the read and the subscription", async () => {
    const h = harness();
    h.store.subscribe = () => Promise.resolve(false);
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    expect(h.push.closed).toStrictEqual([CONNECTION_ID]);
    expect(h.push.posted).toStrictEqual([]);
  });
});

describe("handleClientMessage: heartbeat and ping", () => {
  it.each([["Viewer", "FORBIDDEN_ROLE"]])("refuses a heartbeat from a %s", async (role, code) => {
    const h = harness(connection({ role: role as ConnectionRecord["role"] }));
    await send(h, JSON.stringify({ type: "heartbeat", robotId: "sim-01" }));
    expect(h.push.frames()).toStrictEqual([{ type: "error", code }]);
    expect(h.logger.entries[0]).toMatchObject({ attributes: { reason: "FORBIDDEN_ROLE" } });
  });

  it.each(["Operator", "Admin"] as const)(
    "refuses silently a heartbeat from an %s that holds no lock (no frame, one counted refusal)",
    async (role) => {
      const h = harness(connection({ role }));
      await send(h, JSON.stringify({ type: "heartbeat", robotId: "sim-01" }));
      expect(h.push.posted).toStrictEqual([]);
      expect(h.metrics.counted).toStrictEqual(["HeartbeatRefused"]);
    },
  );

  it("answers a ping with nothing", async () => {
    const h = harness();
    await send(h, JSON.stringify({ type: "ping" }));
    expect(h.push.posted).toStrictEqual([]);
    expect(h.store.calls).toStrictEqual(["getConnection", "countFrame"]);
  });

  it("keeps every frame it sends valid under the server schema", async () => {
    const h = harness();
    h.fleet.listed = [liveState("sim-01")];
    await send(h, JSON.stringify({ type: "subscribe", siteId: SITE }));
    const frames: WsServerMessage[] = h.push.frames();
    expect(frames.every((frame) => frame.type === "fleet.snapshot")).toBe(true);
  });
});
