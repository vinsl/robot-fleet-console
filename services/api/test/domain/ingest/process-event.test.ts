/**
 * Processing of classified deliveries: the effects of each event kind, the alert rules, the presence rules,
 * the relay, and the denied cases (a connection that fails writes nothing, R28).
 */
import { describe, expect, it } from "vitest";
import type { IngestOutcome } from "../../../src/domain/ingest/classify";
import { processOutcome, type ProcessDeps } from "../../../src/domain/ingest/process-event";
import { FixedClock } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";
import {
  BOOT_A,
  FakeAlerts,
  FakeConnections,
  FakeFleetState,
  FakeHistory,
  FakeIngestMetrics,
  FakePush,
  connection,
} from "../../fakes/live";
import { type RobotEvent, WsServerMessageSchema } from "@mfc/protocol";

/** The instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/** The site of the tests. */
const SITE = "paris-01";

/** Message identifier of the tests' events. */
const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";

/** A broker receive time, in milliseconds. */
const RECEIVED_AT = 1_793_595_600_123;

/** Fakes of every port of the processing, kept for assertions. */
interface Rig {
  readonly deps: ProcessDeps;
  readonly state: FakeFleetState;
  readonly alerts: FakeAlerts;
  readonly history: FakeHistory;
  readonly connections: FakeConnections;
  readonly push: FakePush;
  readonly metrics: FakeIngestMetrics;
  readonly logger: RecordingLogger;
}

/**
 * Builds the rig, with one subscriber on the site.
 *
 * @returns The rig.
 */
function rig(): Rig {
  const state = new FakeFleetState();
  state.claims.set("kali-01", SITE);
  const alerts = new FakeAlerts();
  const history = new FakeHistory();
  const connections = new FakeConnections();
  connections.bySite.set(SITE, [connection("conn-1", NOW.getTime() + 3_600_000)]);
  const push = new FakePush();
  const metrics = new FakeIngestMetrics();
  const logger = new RecordingLogger();
  const deps: ProcessDeps = {
    state,
    alerts,
    history,
    connections,
    push,
    clock: new FixedClock(NOW),
    logger,
    metrics,
  };
  return { deps, state, alerts, history, connections, push, metrics, logger };
}

/**
 * A robot event outcome.
 *
 * @param event - The event.
 * @returns The classified outcome.
 */
function eventOutcome(event: RobotEvent): IngestOutcome {
  return { kind: "event", robotId: "kali-01", siteId: SITE, event, receivedAt: RECEIVED_AT };
}

/** The envelope fields every robot event carries. */
const ENVELOPE = {
  schemaVersion: "1.0.0",
  messageId: MESSAGE,
  robotId: "kali-01",
  siteId: SITE,
  ts: "2026-11-02T10:00:00.000Z",
  seq: 42,
  bootId: BOOT_A,
} as const;

/**
 * A presence outcome.
 *
 * @param eventType - The broker event.
 * @param extra - Fields of the notice.
 * @returns The classified outcome.
 */
function presence(
  eventType: "connected" | "disconnected" | "connect_failed",
  extra: {
    clientInitiatedDisconnect?: boolean;
    robotId?: string | null;
    versionNumber?: number;
  } = {},
): IngestOutcome {
  return {
    kind: "presence",
    clientId: "mfc-demo-kali-01",
    robotId: extra.robotId === undefined ? "kali-01" : extra.robotId,
    eventType,
    timestamp: RECEIVED_AT,
    disconnectReason: undefined,
    versionNumber: extra.versionNumber ?? 7,
    ...(extra.clientInitiatedDisconnect === undefined
      ? {}
      : { clientInitiatedDisconnect: extra.clientInitiatedDisconnect }),
  };
}

describe("robot events: state, history and relay", () => {
  it("a heartbeat writes the state and the battery, with no history, alert or relay", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "HEARTBEAT", state: "TELEOP", battery: 64 }),
      r.deps,
    );

    expect(r.state.observations).toStrictEqual([
      expect.objectContaining({
        source: "event",
        state: "TELEOP",
        battery: 64,
        bootId: BOOT_A,
        seq: 42,
      }),
    ]);
    expect(r.history.states).toStrictEqual([]);
    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
    expect(r.metrics.total("StateObserved")).toBe(1);
  });

  it("a boot observes the state (new boot wins) and relays the event", async () => {
    const r = rig();
    r.connections.bySite.set(SITE, [connection("conn-1", NOW.getTime() + 3_600_000)]);

    await processOutcome(
      eventOutcome({
        ...ENVELOPE,
        kind: "BOOT",
        agentVersion: "1.2.3",
        simulated: false,
        state: "IDLE",
      }),
      r.deps,
    );

    expect(r.state.observations[0]).toMatchObject({ state: "IDLE", source: "event" });
    expect(r.state.observations[0]?.battery).toBeUndefined();
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual(["robot.event"]);
  });

  it("a BLOCKED state writes history, opens a Major alert and relays the event then the alert", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({
        ...ENVELOPE,
        kind: "STATE_CHANGED",
        from: "MOVING",
        to: "BLOCKED",
        cause: "OBSTACLE_DETECTED",
      }),
      r.deps,
    );

    expect(r.history.states).toStrictEqual([
      expect.objectContaining({ to: "BLOCKED", from: "MOVING", messageId: MESSAGE }),
    ]);
    expect(r.alerts.opened).toHaveLength(1);
    expect(r.alerts.opened[0]).toMatchObject({
      kind: "BLOCKED",
      severity: "MAJOR",
      cause: "OBSTACLE_DETECTED",
    });
    expect(r.metrics.total("AlertOpened")).toBe(1);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual([
      "robot.event",
      "alert.changed",
    ]);
    expect(r.logger.entries).toStrictEqual([]);
  });

  it("the same state change delivered twice opens no second alert but still relays", async () => {
    const r = rig();
    const outcome = eventOutcome({
      ...ENVELOPE,
      kind: "STATE_CHANGED",
      from: "MOVING",
      to: "BLOCKED",
      cause: "OBSTACLE_DETECTED",
    });
    await processOutcome(outcome, r.deps);
    r.push.posted.length = 0;

    await processOutcome(outcome, r.deps);

    expect(r.alerts.opened).toHaveLength(1);
    expect(r.metrics.total("AlertDeduplicated")).toBe(1);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual(["robot.event"]);
  });

  it("an emergency stop opens a Critical ESTOP alert", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({
        ...ENVELOPE,
        kind: "STATE_CHANGED",
        from: "MOVING",
        to: "ESTOP",
        cause: "ESTOP",
      }),
      r.deps,
    );

    expect(r.alerts.opened[0]).toMatchObject({ kind: "ESTOP", severity: "CRITICAL" });
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual([
      "robot.event",
      "alert.changed",
    ]);
  });

  it("a finished work cycle writes a mission record", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({
        ...ENVELOPE,
        kind: "STATE_CHANGED",
        from: "WORKING",
        to: "IDLE",
        cause: "WORK_DONE",
      }),
      r.deps,
    );

    expect(r.history.missions).toStrictEqual([
      expect.objectContaining({ robotId: "kali-01", messageId: MESSAGE }),
    ]);
    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.logger.entries).toStrictEqual([]);
  });

  it("a non-work transition to IDLE writes no mission", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({
        ...ENVELOPE,
        kind: "STATE_CHANGED",
        from: "PAUSED",
        to: "IDLE",
        cause: "RESUME",
      }),
      r.deps,
    );

    expect(r.history.missions).toStrictEqual([]);
  });

  it("a low battery fault opens a Minor alert and relays the event then the alert", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "FAULT_RAISED", fault: "BATTERY_LOW" }),
      r.deps,
    );

    expect(r.alerts.opened[0]).toMatchObject({ kind: "LOW_BATTERY", severity: "MINOR" });
    expect(r.logger.entries).toStrictEqual([]);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual([
      "robot.event",
      "alert.changed",
    ]);
  });

  it("an obstacle fault is relayed and opens nothing, and writes no state", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "FAULT_RAISED", fault: "OBSTACLE" }),
      r.deps,
    );

    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.state.observations).toStrictEqual([]);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual(["robot.event"]);
  });

  it("a fault cleared and a lock change are relayed only", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "FAULT_CLEARED", fault: "OBSTACLE" }),
      r.deps,
    );
    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "LOCK_CHANGED", held: false, cause: "RELEASED" }),
      r.deps,
    );

    expect(r.state.observations).toStrictEqual([]);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual([
      "robot.event",
      "robot.event",
    ]);
  });

  it("a goodbye stores the boot and relays the event", async () => {
    const r = rig();

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "GOING_OFFLINE", reason: "SHUTDOWN" }),
      r.deps,
    );

    expect(r.state.goodbyes.get("kali-01")).toBe(BOOT_A);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual(["robot.event"]);
  });

  it("a store failure rejects, so the runtime retries the delivery", async () => {
    const r = rig();
    r.state.failingObservations.add("kali-01");

    await expect(
      processOutcome(
        eventOutcome({ ...ENVELOPE, kind: "HEARTBEAT", state: "IDLE", battery: 50 }),
        r.deps,
      ),
    ).rejects.toThrow("store unavailable");
  });

  it("a relay failure is counted and does not reject, after the writes", async () => {
    const r = rig();
    r.connections.failingSites.add(SITE);

    await processOutcome(
      eventOutcome({ ...ENVELOPE, kind: "FAULT_RAISED", fault: "BATTERY_LOW" }),
      r.deps,
    );

    expect(r.alerts.opened).toHaveLength(1);
    expect(r.metrics.total("FanOutListFailed")).toBe(2);
    expect(r.logger.entries.map((entry) => entry.message)).toContain("relay failed");
  });
});

describe("acknowledgements", () => {
  it("relays a command acknowledgement as a valid server frame", async () => {
    const r = rig();
    const ack: Extract<IngestOutcome, { kind: "ack" }>["ack"] = {
      schemaVersion: "1.0.0",
      messageId: MESSAGE,
      robotId: "kali-01",
      siteId: SITE,
      ts: "2026-11-02T10:00:00.000Z",
      seq: 3,
      bootId: BOOT_A,
      commandId: MESSAGE,
      correlationId: "corr-0001-abcd",
      robotTs: "2026-11-02T10:00:00.000Z",
      state: "IDLE",
      result: "ACK",
    };

    await processOutcome(
      { kind: "ack", robotId: "kali-01", siteId: SITE, ack, receivedAt: RECEIVED_AT },
      r.deps,
    );

    const [frame] = r.push.frames();
    expect(frame?.type).toBe("command.ack");
    expect(WsServerMessageSchema.safeParse(frame).success).toBe(true);
    expect(r.state.observations).toStrictEqual([]);
  });
});

describe("presence", () => {
  it("an unclean disconnect marks the robot OFFLINE, opens an OFFLINE alert and relays both", async () => {
    const r = rig();

    await processOutcome(presence("disconnected"), r.deps);

    expect(r.state.presence).toMatchObject([
      { kind: "offline", change: { siteId: SITE, robotId: "kali-01", version: 7 } },
    ]);
    expect(r.alerts.opened[0]).toMatchObject({ kind: "OFFLINE", severity: "MAJOR" });
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual([
      "robot.presence",
      "alert.changed",
    ]);
  });

  it("a clean shutdown (goodbye for the stored boot) marks OFFLINE without an alert", async () => {
    const r = rig();
    r.state.goodbyes.set("kali-01", BOOT_A);
    r.state.storedBoot.set("kali-01", BOOT_A);

    await processOutcome(presence("disconnected", { clientInitiatedDisconnect: true }), r.deps);

    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.push.frames().map((frame) => frame.type)).toStrictEqual(["robot.presence"]);
  });

  it("a client-initiated disconnect without a matching goodbye still opens the alert", async () => {
    const r = rig();
    r.state.goodbyes.set("kali-01", "0190a7c4-0000-7000-8000-0000000000ff");
    r.state.storedBoot.set("kali-01", BOOT_A);

    await processOutcome(presence("disconnected", { clientInitiatedDisconnect: true }), r.deps);

    expect(r.alerts.opened).toHaveLength(1);
  });

  it("a stale disconnect (a newer presence is stored) changes nothing", async () => {
    const r = rig();
    r.state.presenceOutcome = "STALE";

    await processOutcome(presence("disconnected"), r.deps);

    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
  });

  it("a connection marks the robot ONLINE and relays it only when applied", async () => {
    const r = rig();

    await processOutcome(presence("connected"), r.deps);
    expect(r.push.frames()).toMatchObject([{ type: "robot.presence", presence: "ONLINE" }]);

    r.state.presenceOutcome = "STALE";
    r.push.posted.length = 0;
    await processOutcome(presence("connected"), r.deps);
    expect(r.push.posted).toStrictEqual([]);
  });

  it("a failed connection writes nothing, raises nothing and relays nothing (R28)", async () => {
    const r = rig();

    await processOutcome(presence("connect_failed"), r.deps);

    expect(r.state.observations).toStrictEqual([]);
    expect(r.state.presence).toStrictEqual([]);
    expect(r.state.goodbyes.size).toBe(0);
    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.history.states).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
  });

  it("a notice for a robot without a claim counts as unknown and writes nothing", async () => {
    const r = rig();
    r.state.claims.clear();

    await processOutcome(presence("disconnected"), r.deps);

    expect(r.metrics.total("PresenceUnknownRobot")).toBe(1);
    expect(r.state.presence).toStrictEqual([]);
  });

  it("a notice for a client that is not a robot counts as unknown", async () => {
    const r = rig();

    await processOutcome(presence("connected", { robotId: null }), r.deps);

    expect(r.metrics.total("PresenceUnknownRobot")).toBe(1);
    expect(r.state.presence).toStrictEqual([]);
  });

  it("a presence with an out-of-range timestamp falls back to the cloud clock", async () => {
    const r = rig();
    const outcome = {
      ...presence("connected"),
      timestamp: Number.MAX_SAFE_INTEGER,
    } as IngestOutcome;

    await processOutcome(outcome, r.deps);

    expect(r.push.frames()).toMatchObject([{ type: "robot.presence", at: NOW.toISOString() }]);
  });
});

describe("rejected deliveries", () => {
  it("has no effect: the handler logs it", async () => {
    const r = rig();

    await processOutcome(
      { kind: "rejected", reason: "NOT_JSON", robotId: "kali-01", issuePaths: [] },
      r.deps,
    );

    expect(r.state.observations).toStrictEqual([]);
    expect(r.alerts.opened).toStrictEqual([]);
    expect(r.push.posted).toStrictEqual([]);
  });
});
