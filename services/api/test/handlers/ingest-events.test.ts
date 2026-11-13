/**
 * Ingest handler: the denied-access deliveries end as counted, logged rejections without an error, the
 * accepted messages are logged at the right level, and nothing the logs must not carry reaches them.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as IngestModule from "../../src/handlers/ingest-events";
import type {
  IngestDimension,
  IngestEventsHandler,
  IngestEventsHandlerDeps,
  IngestMetrics,
} from "../../src/handlers/ingest-events";
import type { IngestMetricName, IngestDistributionName } from "../../src/domain/ingest/metrics";
import type { HandlerLogger } from "../../src/observability";
import { FixedClock } from "../fakes/fixed";
import { RecordingLogger } from "../fakes/recording";
import { FakeAlerts, FakeConnections, FakeFleetState, FakeHistory, FakePush } from "../fakes/live";

/** Directory of the protocol fixtures, shared with the protocol package. */
const FIXTURES = fileURLToPath(new URL("../../../../packages/protocol/fixtures/", import.meta.url));

/** Environment of the function. The values are fakes. */
const TEST_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
  WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
};

/** The loaded handler module, imported once the environment is set. */
let ingest: typeof IngestModule;

beforeAll(async () => {
  for (const [name, value] of Object.entries(TEST_ENVIRONMENT)) {
    vi.stubEnv(name, value);
  }
  ingest = await import("../../src/handlers/ingest-events");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** A payload that stands for a robot's data: it must never reach a log line. */
const PAYLOAD_MARKER = "PAYLOAD-MARKER-5d2c";

/** An address that a presence notice carries: it must never reach a log line. */
const ADDRESS_MARKER = "203.0.113.77";

/** Logger that keeps its entries and the keys currently appended to it. */
class HandlerLog extends RecordingLogger implements HandlerLogger {
  /** Keys currently appended. */
  readonly keys = new Map<string, unknown>();

  /** The Lambda context is not under test here. */
  addContext(): void {
    // Intentionally empty: the context of the test is not logged.
  }

  /** @param keys - Keys to append. */
  appendKeys(keys: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(keys)) {
      this.keys.set(key, value);
    }
  }

  /** @param keys - Keys to remove. */
  removeKeys(keys: string[]): void {
    for (const key of keys) {
      this.keys.delete(key);
    }
  }
}

/** Metrics that keep every counted occurrence and the number of publications. */
class HandlerCounter implements IngestMetrics {
  /** Every count, in order. The amount is not kept: the tests count occurrences. */
  readonly counts: { name: IngestMetricName; dimension: IngestDimension | undefined }[] = [];
  /** Every distribution value, in order. */
  readonly distributions: { name: IngestDistributionName; value: number }[] = [];
  /** Number of publications, one per invocation. */
  publishes = 0;
  /** Set to make every count fail, to test the unexpected-error path. */
  failCounts = false;

  /**
   * @param name - The metric.
   * @param dimension - The dimension of the occurrence.
   */
  count(name: IngestMetricName, dimension?: IngestDimension): void {
    if (this.failCounts) {
      throw new Error("metrics unavailable");
    }
    this.counts.push({ name, dimension });
  }

  /** @param name - The distribution. @param value - The value. */
  record(name: IngestDistributionName, value: number): void {
    this.distributions.push({ name, value });
  }

  /** Counts one publication. */
  publishStoredMetrics(): void {
    this.publishes += 1;
  }
}

/** A handler under test with the observers and the fakes it writes to. */
interface Harness {
  readonly handler: IngestEventsHandler;
  readonly logger: HandlerLog;
  readonly metrics: HandlerCounter;
  readonly state: FakeFleetState;
  readonly push: FakePush;
  readonly connections: FakeConnections;
}

/**
 * @returns A fresh handler over fresh observers and fresh store fakes. The kali-01 robot is claimed by
 * paris-01, so its presence and its state can be written.
 */
function harness(): Harness {
  const logger = new HandlerLog();
  const metrics = new HandlerCounter();
  const state = new FakeFleetState();
  state.claims.set("kali-01", "paris-01");
  const push = new FakePush();
  const connections = new FakeConnections();
  const deps: IngestEventsHandlerDeps = {
    logger,
    metrics,
    state,
    alerts: new FakeAlerts(),
    history: new FakeHistory(),
    connections,
    push,
    clock: new FixedClock(new Date("2026-11-02T10:00:00.000Z")),
  };
  return {
    handler: ingest.createIngestEventsHandler(deps),
    logger,
    metrics,
    state,
    push,
    connections,
  };
}

/**
 * @param remainingMs - Time the invocation has left.
 * @returns A Lambda context with the fields the handler reads.
 */
function lambdaContext(remainingMs = 10_000): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "mfc-demo-ingest-events",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-ingest-events",
    memoryLimitInMB: "256",
    awsRequestId: "req-00000002",
    logGroupName: "/aws/lambda/mfc-demo-ingest-events",
    logStreamName: "2026/11/02/test",
    getRemainingTimeInMillis: () => remainingMs,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

/**
 * Reads one protocol fixture as text.
 *
 * @param relative - Path under `packages/protocol/fixtures`.
 * @returns The file content.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fixture names are fixed by the tests; no input reaches these reads */
function fixtureText(relative: string): string {
  return readFileSync(path.join(FIXTURES, relative), "utf8");
}

/**
 * Lists the fixture names of a folder.
 *
 * @param folder - Folder under `packages/protocol/fixtures`.
 * @returns The JSON file names, sorted.
 */
function fixtureNames(folder: string): string[] {
  return readdirSync(path.join(FIXTURES, folder))
    .filter((name) => name.endsWith(".json"))
    .sort();
}
/* eslint-enable security/detect-non-literal-fs-filename */

/**
 * Builds the Lambda event of a topic rule delivery.
 *
 * @param topic - The topic the message came from.
 * @param clientId - The MQTT client id the broker recorded.
 * @param payloadText - The JSON text of the message, or any raw text.
 * @returns The delivery as the runtime passes it.
 */
function robotDelivery(
  topic: string,
  clientId: string,
  payloadText: string,
): Record<string, unknown> {
  return {
    source: "robot",
    iotTopic: topic,
    iotClientId: clientId,
    iotReceivedAt: 1_793_000_000_000,
    payloadBase64: Buffer.from(payloadText, "utf8").toString("base64"),
  };
}

/**
 * The reference event: the BOOT fixture of the reference robot, as text.
 *
 * @returns The JSON text of the event.
 */
function referenceEventText(): string {
  return fixtureText("robot-event/valid/01.json");
}

/**
 * The reference event as an object, for the cases that alter one field of it.
 *
 * @returns The event, typed as a JSON object.
 */
function referenceEvent(): Record<string, unknown> {
  return JSON.parse(referenceEventText()) as Record<string, unknown>;
}

/**
 * Serialises every log entry, so that a test can look for a value that must not appear.
 *
 * @param logger - The logger under test.
 * @returns The entries as one text.
 */
function logText(logger: HandlerLog): string {
  return logger.text();
}

describe("ingest handler: accepted deliveries", () => {
  it("logs an accepted event at info and counts it on the events channel", async () => {
    const { handler, logger, metrics } = harness();

    await handler(
      robotDelivery(
        "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events",
        "mfc-demo-kali-01",
        referenceEventText(),
      ),
      lambdaContext(),
    );

    expect(metrics.counts).toStrictEqual([
      { name: "RobotMessageAccepted", dimension: { name: "channel", value: "events" } },
      { name: "StateObserved", dimension: { name: "outcome", value: "APPLIED" } },
    ]);
    expect(logger.entries).toStrictEqual([
      {
        level: "info",
        message: "robot event",
        attributes: {
          robotId: "kali-01",
          siteId: "paris-01",
          kind: "BOOT",
          seq: 42,
          bootId: "0190a7c4-0000-7000-8000-000000000001",
          messageId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
        },
      },
    ]);
  });

  it("logs a heartbeat at debug, so that it stays out of the default level", async () => {
    const { handler, logger } = harness();
    const heartbeat = fixtureText("robot-event/valid/04.json");

    await handler(
      robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", heartbeat),
      lambdaContext(),
    );

    const [entry] = logger.entries;
    expect(entry?.level).toBe("debug");
    expect(entry?.message).toBe("robot event");
  });

  it("appends the correlation id of an ack for its log line, then removes it", async () => {
    const { handler, logger, metrics } = harness();
    const ack = fixtureText("ack/valid/01.json");

    await handler(
      robotDelivery(
        "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
        "mfc-demo-kali-01",
        ack,
      ),
      lambdaContext(),
    );

    expect(metrics.counts).toStrictEqual([
      { name: "RobotMessageAccepted", dimension: { name: "channel", value: "ack" } },
    ]);
    expect(logger.entries).toStrictEqual([
      {
        level: "info",
        message: "robot ack",
        attributes: {
          commandId: "0190a7c5-1f00-7a00-8b00-00000000c001",
          result: "ACK",
          reason: undefined,
        },
      },
    ]);
    expect(logger.keys.has("correlationId")).toBe(false);
  });

  it("logs a refused command with its reason", async () => {
    const { handler, logger } = harness();
    const refused = fixtureText("ack/valid/02.json");

    await handler(
      robotDelivery(
        "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
        "mfc-demo-kali-01",
        refused,
      ),
      lambdaContext(),
    );

    expect(logger.entries[0]?.attributes).toMatchObject({
      result: "REJECT",
      reason: "NOT_LOCK_HOLDER",
    });
  });

  it("logs a presence notice at info, and a failed connection at warn", async () => {
    const { handler, logger, metrics } = harness();

    await handler(
      { source: "presence", clientId: "mfc-demo-kali-01", eventType: "connected", timestamp: 1 },
      lambdaContext(),
    );
    await handler(
      {
        source: "presence",
        clientId: "mfc-demo-kali-01",
        eventType: "connect_failed",
        timestamp: 2,
        connectFailureReason: "AUTHENTICATION_FAILURE",
      },
      lambdaContext(),
    );

    expect(logger.entries.map((entry) => entry.level)).toStrictEqual(["info", "warn"]);
    expect(metrics.counts.map((count) => count.dimension)).toStrictEqual([
      { name: "eventType", value: "connected" },
      { name: "eventType", value: "connect_failed" },
    ]);
  });

  it("counts a presence notice of a client that is not a robot, with no robot in the log", async () => {
    const { handler, logger, metrics } = harness();

    await handler(
      { source: "presence", clientId: "other", eventType: "disconnected", timestamp: 3 },
      lambdaContext(),
    );

    expect(metrics.counts).toStrictEqual([
      { name: "PresenceEvent", dimension: { name: "eventType", value: "disconnected" } },
      { name: "PresenceUnknownRobot", dimension: undefined },
    ]);
    expect(logger.entries[0]?.attributes).toStrictEqual({
      clientId: "other",
      eventType: "disconnected",
      disconnectReason: undefined,
      versionNumber: undefined,
    });
  });
});

describe("ingest handler: denied deliveries are refused without an error", () => {
  it.each([
    [
      "IDENTITY_MISMATCH",
      "fleet/paris-01/sim-01/events",
      "mfc-demo-sim-01",
      { ...referenceEvent(), robotId: "sim-02" },
    ],
    ["CLIENT_MISMATCH", "fleet/paris-01/sim-01/events", "mfc-demo-sim-02", referenceEvent()],
    ["WRONG_CHANNEL", "fleet/paris-01/kali-01/telemetry", "mfc-demo-kali-01", referenceEvent()],
    [
      "UNKNOWN_TOPIC",
      "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/cmd/ack",
      "mfc-demo-kali-01",
      referenceEvent(),
    ],
  ])(
    "refuses %s, counts it and logs a warning without the payload",
    async (reason, topic, clientId, payload) => {
      const { handler, logger, metrics } = harness();
      const event = robotDelivery(topic, clientId, JSON.stringify(payload));

      await expect(handler(event, lambdaContext())).resolves.toBeUndefined();

      expect(metrics.counts).toStrictEqual([
        { name: "RobotMessageRejected", dimension: { name: "reason", value: reason } },
      ]);
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]?.level).toBe("warn");
      expect(logger.entries[0]?.attributes).toMatchObject({ reason });
      expect(logText(logger)).not.toContain(
        Buffer.from(JSON.stringify(payload)).toString("base64"),
      );
    },
  );

  it("refuses an oversize payload (OVERSIZE) without parsing it", async () => {
    const { handler, logger, metrics } = harness();
    const oversize = `{"pad":"${PAYLOAD_MARKER}${"x".repeat(4096)}"}`;

    await handler(
      robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", oversize),
      lambdaContext(),
    );

    expect(metrics.counts).toStrictEqual([
      { name: "RobotMessageRejected", dimension: { name: "reason", value: "OVERSIZE" } },
    ]);
    expect(logText(logger)).not.toContain(PAYLOAD_MARKER);
  });

  it("refuses text that is not JSON (NOT_JSON)", async () => {
    const { handler, metrics } = harness();

    await handler(
      robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", "{not json"),
      lambdaContext(),
    );

    expect(metrics.counts).toStrictEqual([
      { name: "RobotMessageRejected", dimension: { name: "reason", value: "NOT_JSON" } },
    ]);
  });

  it.each(fixtureNames("robot-event/invalid"))(
    "refuses the invalid event %s (SCHEMA)",
    async (name) => {
      const { handler, metrics } = harness();
      const text = fixtureText(`robot-event/invalid/${name}`);

      await handler(
        robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", text),
        lambdaContext(),
      );

      expect(metrics.counts).toStrictEqual([
        { name: "RobotMessageRejected", dimension: { name: "reason", value: "SCHEMA" } },
      ]);
    },
  );

  it("logs the schema paths of a refusal, never the values", async () => {
    const { handler, logger } = harness();
    const bad = { ...referenceEvent(), messageId: `0190A7C4-${PAYLOAD_MARKER}` };

    await handler(
      robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", JSON.stringify(bad)),
      lambdaContext(),
    );

    expect(logger.entries[0]?.attributes).toMatchObject({
      reason: "SCHEMA",
      issuePaths: ["messageId"],
    });
    expect(logText(logger)).not.toContain(PAYLOAD_MARKER);
  });

  it("refuses a malformed delivery as a count, with no robot in the log", async () => {
    const { handler, logger, metrics } = harness();

    await handler({ source: "robot", iotTopic: "fleet/paris-01/kali-01/events" }, lambdaContext());

    expect(metrics.counts).toStrictEqual([
      { name: "RobotMessageRejected", dimension: { name: "reason", value: "MALFORMED_DELIVERY" } },
    ]);
    expect(logger.entries[0]?.attributes).toStrictEqual({
      reason: "MALFORMED_DELIVERY",
      robotId: null,
      issuePaths: [],
    });
  });

  it("never logs the address of a presence notice", async () => {
    const { handler, logger } = harness();

    await handler(
      {
        source: "presence",
        clientId: "mfc-demo-kali-01",
        eventType: "connected",
        timestamp: 4,
        ipAddress: ADDRESS_MARKER,
      },
      lambdaContext(),
    );

    expect(logText(logger)).not.toContain(ADDRESS_MARKER);
  });
});

describe("ingest handler: invocation lifecycle", () => {
  it("publishes its metrics once per invocation, on acceptance and on refusal", async () => {
    const { handler, metrics } = harness();

    await handler(
      robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", referenceEventText()),
      lambdaContext(),
    );
    await handler(
      robotDelivery("fleet/paris-01/sim-01/events", "mfc-demo-sim-02", referenceEventText()),
      lambdaContext(),
    );

    expect(metrics.publishes).toBe(2);
  });

  it("rethrows an unexpected error after logging its name only, and still publishes", () => {
    const { handler, logger, metrics } = harness();
    metrics.failCounts = true;

    // The handler throws synchronously, which the runtime treats like a rejected promise.
    expect(() =>
      handler(
        robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", referenceEventText()),
        lambdaContext(),
      ),
    ).toThrow("metrics unavailable");

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe("error");
    expect(logger.entries[0]?.message).toBe("unhandled error");
    expect(logText(logger)).not.toContain("metrics unavailable");
    expect(metrics.publishes).toBe(1);
  });
});

describe("ingest handler: store failures", () => {
  it("rejects after logging the error name only, and still publishes, when the store fails", async () => {
    const { handler, logger, metrics, state } = harness();
    state.failingObservations.add("kali-01");

    await expect(
      handler(
        robotDelivery("fleet/paris-01/kali-01/events", "mfc-demo-kali-01", referenceEventText()),
        lambdaContext(),
      ),
    ).rejects.toThrow("store unavailable");

    expect(logger.entries.at(-1)).toMatchObject({
      level: "error",
      message: "unhandled error",
      attributes: { errorName: "Error" },
    });
    expect(logText(logger)).not.toContain("store unavailable");
    expect(metrics.publishes).toBe(1);
  });
});
