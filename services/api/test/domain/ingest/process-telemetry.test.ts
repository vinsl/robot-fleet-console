/**
 * Batch processing of telemetry: the counts, the partial failures, the deadline, the in-container ordering,
 * and the log hygiene. The ports are the in-memory fakes, the clock and the deadline are scripted.
 */
import { describe, expect, it } from "vitest";
import { PersistPolicy } from "../../../src/domain/live/persist-policy";
import {
  processTelemetryBatch,
  type TelemetryDeps,
  type TelemetryRecord,
} from "../../../src/domain/ingest/process-telemetry";
import { RecordingLogger } from "../../fakes/recording";
import { FixedClock, ScriptedDeadline } from "../../fakes/fixed";
import {
  BOOT_A,
  BOOT_B,
  FakeConnections,
  FakeFleetState,
  FakePush,
  connection,
} from "../../fakes/live";
import { messageIdOf, telemetryBody } from "../../fakes/telemetry-body";

/** The instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/** The site of the tests. */
const SITE = "paris-01";

/** A rig of ports for one batch, with the fakes kept for assertions. */
interface Rig {
  readonly deps: TelemetryDeps;
  readonly state: FakeFleetState;
  readonly connections: FakeConnections;
  readonly push: FakePush;
  readonly policy: PersistPolicy;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly deadline: ScriptedDeadline;
}

/**
 * Builds a rig with one subscribed connection on the test site.
 *
 * @returns The rig.
 */
function rig(): Rig {
  const state = new FakeFleetState();
  const connections = new FakeConnections();
  connections.bySite.set(SITE, [connection("conn-1", NOW.getTime() + 3_600_000)]);
  const push = new FakePush();
  const policy = new PersistPolicy();
  const clock = new FixedClock(NOW);
  const logger = new RecordingLogger();
  const deadline = new ScriptedDeadline(60_000);
  return {
    deps: { state, connections, push, policy, clock, logger, deadline },
    state,
    connections,
    push,
    policy,
    clock,
    logger,
    deadline,
  };
}

/**
 * A queue record of a telemetry message.
 *
 * @param n - The message number, which is also its identifier.
 * @param options - The telemetry options.
 * @returns The record.
 */
function record(n: number, options: Parameters<typeof telemetryBody>[0] = {}): TelemetryRecord {
  return { messageId: messageIdOf(n), body: telemetryBody(options, n) };
}

describe("processTelemetryBatch: the reference batch", () => {
  it("counts the accepted, the rejected and the superseded, writes once per robot, fans out one frame", async () => {
    const r = rig();
    const records = [
      record(1, { robotId: "kali-01", seq: 1 }),
      record(2, { robotId: "kali-01", seq: 2 }),
      record(3, { robotId: "sim-01", seq: 1 }),
      record(4, { robotId: "sim-02", seq: 1 }),
      record(5, { robotId: "sim-03", seq: 1 }),
      record(6, { robotId: "kali-01", seq: 2 }),
      record(7, { robotId: "sim-04", seq: 1, battery: 101 }),
    ];

    const result = await processTelemetryBatch(records, r.deps);

    expect(result.failedMessageIds).toStrictEqual([]);
    expect(result.stats).toMatchObject({
      batchSize: 7,
      accepted: 6,
      rejected: new Map([["SCHEMA", 1]]),
      superseded: 2,
      persisted: 4,
      refused: 0,
      fanOutSent: 1,
    });
    expect(r.state.observations.map((o) => o.robotId)).toStrictEqual([
      "kali-01",
      "sim-01",
      "sim-02",
      "sim-03",
    ]);
    const frames = r.push.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "fleet.delta", siteId: SITE });
  });

  it("writes the telemetry source with the pose, the battery and the mission", async () => {
    const r = rig();
    await processTelemetryBatch(
      [record(1, { robotId: "kali-01", missionId: "m-0001", state: "WORKING" })],
      r.deps,
    );

    expect(r.state.observations[0]).toMatchObject({
      siteId: SITE,
      robotId: "kali-01",
      source: "telemetry",
      state: "WORKING",
      battery: 81.5,
      pose: { x: 12.5, y: -3.25, heading: 1.57, speed: 0.8 },
      missionId: "m-0001",
      receivedAt: 1_793_595_600_123,
    });
  });

  it("measures the ingest latency from the oldest kept sample", async () => {
    const r = rig();
    await processTelemetryBatch(
      [record(1, { robotId: "kali-01", receivedAt: NOW.getTime() - 1500 })],
      r.deps,
    );

    const batch = await processTelemetryBatch(
      [record(2, { robotId: "sim-01", receivedAt: NOW.getTime() - 700 })],
      r.deps,
    );
    expect(batch.stats.ingestLatencyMs).toBe(700);
  });
});

describe("processTelemetryBatch: rejections and logs", () => {
  it("logs each rejection with its reason and the robot, never the payload", async () => {
    const r = rig();
    const body = telemetryBody({ robotId: "kali-01", battery: 101 }, 1);
    const payloadBase64 = (JSON.parse(body) as { payloadBase64: string }).payloadBase64;

    await processTelemetryBatch([{ messageId: messageIdOf(1), body }], r.deps);

    expect(r.logger.entries).toStrictEqual([
      {
        level: "warn",
        message: "telemetry rejected",
        attributes: { reason: "SCHEMA", robotId: "kali-01" },
      },
    ]);
    expect(r.logger.text()).not.toContain(payloadBase64);
  });

  it("counts a body that is not JSON as NOT_JSON, without a failure", async () => {
    const r = rig();

    const result = await processTelemetryBatch(
      [{ messageId: messageIdOf(1), body: "{not json" }],
      r.deps,
    );

    expect(result.failedMessageIds).toStrictEqual([]);
    expect(result.stats.rejected).toStrictEqual(new Map([["NOT_JSON", 1]]));
    expect(r.state.observations).toStrictEqual([]);
  });
});

describe("processTelemetryBatch: partial failures", () => {
  it("returns only the failing robot's message ids, persists the others, and still fans out", async () => {
    const r = rig();
    r.state.failingObservations.add("sim-02");
    const records = [
      record(1, { robotId: "kali-01" }),
      record(2, { robotId: "sim-02" }),
      record(3, { robotId: "sim-02", seq: 2 }),
    ];

    const result = await processTelemetryBatch(records, r.deps);

    expect(result.failedMessageIds).toStrictEqual([messageIdOf(2), messageIdOf(3)]);
    expect(result.stats).toMatchObject({ persisted: 1, persistFailed: 1, fanOutSent: 1 });
    const [frame] = r.push.frames();
    expect(frame).toMatchObject({ type: "fleet.delta" });
    expect(JSON.stringify(frame)).toContain("kali-01");
  });

  it("does not fan out the sample of a robot whose write failed, even when it is the only one", async () => {
    const r = rig();
    r.state.failingObservations.add("sim-02");

    const result = await processTelemetryBatch([record(2, { robotId: "sim-02" })], r.deps);

    expect(result.failedMessageIds).toStrictEqual([messageIdOf(2)]);
    expect(result.stats).toMatchObject({
      persistFailed: 1,
      fanOutSent: 0,
      ingestLatencyMs: undefined,
    });
    expect(r.push.posted).toStrictEqual([]);
  });

  it("does not remember a sample whose write failed, so its redelivery is processed", async () => {
    const r = rig();
    r.state.failingObservations.add("sim-02");
    await processTelemetryBatch([record(2, { robotId: "sim-02" })], r.deps);

    expect(r.policy.lastSeen("sim-02")).toBeUndefined();
  });

  it("counts the expired sessions and the truncated listings of the fan-out", async () => {
    const r = rig();
    r.connections.bySite.set(SITE, [connection("gone-soon", NOW.getTime() - 1)]);
    r.connections.truncatedSites.add(SITE);

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01" })], r.deps);

    expect(result.stats).toMatchObject({ fanOutExpired: 1, fanOutTruncated: 1 });
  });

  it("counts a failed fan-out without failing the batch", async () => {
    const r = rig();
    r.connections.failingSites.add(SITE);

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01" })], r.deps);

    expect(result.failedMessageIds).toStrictEqual([]);
    expect(result.stats).toMatchObject({ persisted: 1, fanOutListFailed: 1, fanOutSent: 0 });
    expect(r.logger.entries.map((entry) => entry.message)).toContain("fan-out failed");
  });
});

describe("processTelemetryBatch: deadline", () => {
  it("returns every message unprocessed when less than the margin is left", async () => {
    const r = rig();
    r.deadline.queue(1500, 1500, 1500);

    const result = await processTelemetryBatch(
      [record(1, { robotId: "kali-01" }), record(2, { robotId: "sim-01" })],
      r.deps,
    );

    expect(result.failedMessageIds).toStrictEqual([messageIdOf(1), messageIdOf(2)]);
    expect(result.stats.deferred).toBe(2);
    expect(r.state.observations).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
  });

  it("skips the fan-out when the margin is gone after the writes, the samples stay stored", async () => {
    const r = rig();
    // First read: the check before the robot. Second read: the check before the fan-out.
    r.deadline.queue(60_000, 1500);

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01" })], r.deps);

    expect(result.failedMessageIds).toStrictEqual([]);
    expect(r.state.observations).toHaveLength(1);
    expect(r.push.posted).toStrictEqual([]);
  });
});

describe("processTelemetryBatch: ordering and persistence policy", () => {
  it("drops a robot's sample the container has already passed, counted as stale", async () => {
    const r = rig();
    r.policy.recordSeen("kali-01", BOOT_A, 10);

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01", seq: 5 })], r.deps);

    expect(result.stats.stale).toBe(1);
    expect(r.state.observations).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
  });

  it("keeps a later boot even if its sequence restarts", async () => {
    const r = rig();
    r.policy.recordSeen("kali-01", BOOT_A, 10);

    const result = await processTelemetryBatch(
      [record(1, { robotId: "kali-01", bootId: BOOT_B, seq: 0 })],
      r.deps,
    );

    expect(result.stats.stale).toBe(0);
    expect(r.state.observations).toHaveLength(1);
  });

  it("fans out without writing when the policy does not require a write", async () => {
    const r = rig();
    await processTelemetryBatch([record(1, { robotId: "kali-01", seq: 1 })], r.deps);
    r.clock.advance(3000);

    const result = await processTelemetryBatch([record(2, { robotId: "kali-01", seq: 2 })], r.deps);

    expect(result.stats).toMatchObject({ persisted: 0, fanOutSent: 1 });
    expect(r.state.observations).toHaveLength(1);
    expect(r.push.posted).toHaveLength(2);
  });

  it("counts a sample refused because the store holds a later boot, and logs it by robot", async () => {
    const r = rig();
    r.state.observeOutcome = "STALE_BOOT";

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01" })], r.deps);

    expect(result.stats).toMatchObject({ refused: 1, staleBootRefused: 1, fanOutSent: 0 });
    expect(r.logger.entries.map((entry) => entry.message)).toContain(
      "state refused: stored boot is later",
    );
  });

  it("counts a refused write (a stale or late sample) and does not fan it out", async () => {
    const r = rig();
    r.state.observeOutcome = "BEFORE_OFFLINE";

    const result = await processTelemetryBatch([record(1, { robotId: "kali-01" })], r.deps);

    expect(result.stats).toMatchObject({ refused: 1, persisted: 0, fanOutSent: 0 });
    expect(r.push.posted).toStrictEqual([]);
  });
});
