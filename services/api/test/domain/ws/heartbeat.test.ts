/**
 * Tests of the heartbeat rule: a publish only for the verified holder of a live lock, silent refusals, refresh near
 * expiry, a publish failure that never throws, the site taken from the stored connection, and the once-per-second
 * log throttle.
 */
import { CommandSchema, commandTopic, type RobotId } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import type { LockItem } from "../../../src/domain/control/ports";
import {
  HEARTBEAT_LOG_INTERVAL_MS,
  HeartbeatLogThrottle,
  handleHeartbeat,
  type HeartbeatDeps,
} from "../../../src/domain/ws/heartbeat";
import type { ConnectionRecord } from "../../../src/domain/ws/session";
import { FIXTURE_TOKEN, FakeLockStore, FakePublisher } from "../../fakes/control";
import { FixedClock, SequentialIds } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";
import { RecordingWsMetrics } from "../../fakes/ws-session";

/** Fixed instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");
/** Epoch seconds of the fixed instant. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
/** The site of the connection and of the lock. */
const SITE = "paris-01";
/** The robot of the tests. */
const ROBOT: RobotId = "sim-01";
/** The holder of the lock. */
const HOLDER = "00000000-0000-4000-8000-000000000001";
/** Another subject. */
const OTHER = "00000000-0000-4000-8000-000000000002";

/** The fakes of one test, with the handler dependencies assembled. */
interface Harness {
  readonly deps: HeartbeatDeps;
  readonly locks: FakeLockStore;
  readonly publisher: FakePublisher;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly metrics: RecordingWsMetrics;
  readonly calls: string[];
}

/**
 * Builds the fakes and the dependencies of the heartbeat rule.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const calls: string[] = [];
  const clock = new FixedClock(NOW);
  const logger = new RecordingLogger();
  const metrics = new RecordingWsMetrics();
  const locks = new FakeLockStore(calls);
  const publisher = new FakePublisher(calls);
  return {
    deps: {
      locks,
      publisher,
      clock,
      ids: new SequentialIds(),
      logger,
      metrics,
      logThrottle: new HeartbeatLogThrottle(),
    },
    locks,
    publisher,
    clock,
    logger,
    metrics,
    calls,
  };
}

/**
 * A stored connection of the holder, open for one hour.
 *
 * @param overrides - Fields to change.
 * @returns The record.
 */
function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: "abcdef12",
    sub: HOLDER,
    role: "Operator",
    siteId: SITE,
    connectedAtMs: NOW.getTime(),
    sessionExpiresAtMs: NOW.getTime() + 60 * 60 * 1000,
    subscribed: true,
    ...overrides,
  };
}

/**
 * A lock of a robot held by a subject, expiring after the given seconds.
 *
 * @param holder - The subject of the holder.
 * @param ttlSeconds - Seconds from the fixed instant until the expiry.
 * @param robotId - The robot of the lock.
 * @returns The lock item.
 */
function lockOf(holder: string, ttlSeconds = 30, robotId: RobotId = ROBOT): LockItem {
  return {
    robotId,
    holder,
    token: FIXTURE_TOKEN,
    acquiredAt: NOW.toISOString(),
    expiresAt: NOW_SECONDS + ttlSeconds,
  };
}

/**
 * The commands published so far, parsed by the protocol schema.
 *
 * @param publisher - The publisher fake.
 * @returns The validated commands, in order.
 */
function publishedCommands(publisher: FakePublisher): ReturnType<typeof CommandSchema.parse>[] {
  return publisher.published.map((entry) => CommandSchema.parse(JSON.parse(entry.payload)));
}

describe("handleHeartbeat: publish", () => {
  it("heartbeat-holder-publishes: publishes one HEARTBEAT with the stored token and the holder as issuer", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.publisher.published).toHaveLength(1);
    expect(h.publisher.published[0]?.topic).toBe(commandTopic(SITE, ROBOT));
    expect(publishedCommands(h.publisher)[0]).toMatchObject({
      type: "HEARTBEAT",
      robotId: ROBOT,
      siteId: SITE,
      issuedBy: HOLDER,
      lockToken: FIXTURE_TOKEN,
    });
    expect(h.metrics.counted).toStrictEqual(["HeartbeatPublished"]);
  });

  it("uses fresh identifiers for every published heartbeat", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER));
    await handleHeartbeat(h.deps, connection(), ROBOT);
    await handleHeartbeat(h.deps, connection(), ROBOT);

    const [first, second] = publishedCommands(h.publisher);
    if (first === undefined || second === undefined) {
      throw new Error("expected two heartbeat publishes");
    }
    expect(first.commandId).not.toBe(second.commandId);
    expect(first.messageId).not.toBe(second.messageId);
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it("heartbeat-site-from-record: takes the site from the stored connection for the lock read and the topic", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER));
    await handleHeartbeat(h.deps, connection({ siteId: SITE }), ROBOT);

    expect(h.calls).toContain("locks.get");
    expect(h.publisher.published[0]?.topic).toBe(`fleet/${SITE}/${ROBOT}/cmd`);
  });

  it("heartbeat-publish-failure-does-not-throw: counts and logs the failure, and resolves", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER));
    h.publisher.failure = new Error("publish refused");
    await expect(handleHeartbeat(h.deps, connection(), ROBOT)).resolves.toBeUndefined();

    expect(h.metrics.counted).toStrictEqual(["HeartbeatPublishFailed"]);
    expect(h.logger.entries).toMatchObject([
      { level: "error", message: "heartbeat publish failed" },
    ]);
  });
});

describe("handleHeartbeat: refusals", () => {
  it("heartbeat-non-holder-ignored: a live lock of another subject publishes nothing and counts a refusal", async () => {
    const h = harness();
    h.locks.put(lockOf(OTHER));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.publisher.published).toStrictEqual([]);
    expect(h.metrics.counted).toStrictEqual(["HeartbeatRefused"]);
  });

  it("heartbeat-expired-lock-ignored: an expired lock of the holder publishes nothing", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER, 0));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.publisher.published).toStrictEqual([]);
    expect(h.metrics.counted).toStrictEqual(["HeartbeatRefused"]);
  });

  it("refuses when no lock exists for the robot, silently (the frame is for another robot)", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER, 30, "sim-02"));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.publisher.published).toStrictEqual([]);
    expect(h.metrics.counted).toStrictEqual(["HeartbeatRefused"]);
    expect(h.logger.entries).toMatchObject([
      { level: "warn", attributes: { reason: "NO_LIVE_LOCK" } },
    ]);
  });
});

describe("handleHeartbeat: lock refresh", () => {
  it("heartbeat-refreshes-lock-near-expiry: moves the expiry when less than 20 s remain", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER, 15));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.locks.lastRefreshExpiry).toBe(NOW_SECONDS + 30);
  });

  it("leaves the expiry alone while more than 20 s remain", async () => {
    const h = harness();
    h.locks.put(lockOf(HOLDER, 25));
    await handleHeartbeat(h.deps, connection(), ROBOT);

    expect(h.locks.lastRefreshExpiry).toBeUndefined();
    expect(h.calls).not.toContain("locks.refresh");
  });
});

describe("handleHeartbeat: log throttle", () => {
  it("logs refusals at most once per second, and still counts each one", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await handleHeartbeat(h.deps, connection(), ROBOT);
    }
    expect(h.logger.entries).toHaveLength(1);

    h.clock.advance(HEARTBEAT_LOG_INTERVAL_MS - 1);
    await handleHeartbeat(h.deps, connection(), ROBOT);
    expect(h.logger.entries).toHaveLength(1);

    h.clock.advance(1);
    await handleHeartbeat(h.deps, connection(), ROBOT);
    expect(h.logger.entries).toHaveLength(2);
    expect(h.metrics.counted).toHaveLength(5);
  });
});

describe("HeartbeatLogThrottle", () => {
  it("lets the first entry through, then one entry per interval", () => {
    const throttle = new HeartbeatLogThrottle();
    expect(throttle.allow(0)).toBe(true);
    expect(throttle.allow(HEARTBEAT_LOG_INTERVAL_MS - 1)).toBe(false);
    expect(throttle.allow(HEARTBEAT_LOG_INTERVAL_MS)).toBe(true);
  });
});
