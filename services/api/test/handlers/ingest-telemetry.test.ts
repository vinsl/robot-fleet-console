/**
 * Ingest handler of the telemetry queue: the batch contract (batch failures, never a failure for a bad
 * message), the counts it publishes, the log hygiene, and the production wiring that must not call AWS at load.
 */
import type { Context } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as TelemetryModule from "../../src/handlers/ingest-telemetry";
import type {
  IngestTelemetryDeps,
  IngestTelemetryHandler,
} from "../../src/handlers/ingest-telemetry";
import { PersistPolicy } from "../../src/domain/live/persist-policy";
import { FixedClock } from "../fakes/fixed";
import { RecordingHandlerLogger } from "../fakes/recording";
import {
  FakeConnections,
  FakeFleetState,
  FakeIngestMetrics,
  FakePush,
  connection,
} from "../fakes/live";
import { messageIdOf, telemetryBody } from "../fakes/telemetry-body";

/** The loaded module, imported once the environment is set. */
let telemetry: typeof TelemetryModule;

beforeAll(async () => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv(
    "WS_MANAGEMENT_ENDPOINT",
    "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
  );
  telemetry = await import("../../src/handlers/ingest-telemetry");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** The instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/** The site of the tests. */
const SITE = "paris-01";

/** A subscriber that stays connected, and the fakes of the handler. */
interface Harness {
  readonly handler: IngestTelemetryHandler;
  readonly logger: RecordingHandlerLogger;
  readonly metrics: FakeIngestMetrics;
  readonly state: FakeFleetState;
  readonly push: FakePush;
  readonly connections: FakeConnections;
}

/**
 * @returns A handler over fresh fakes, with one subscriber on the site.
 */
function harness(): Harness {
  const logger = new RecordingHandlerLogger();
  const metrics = new FakeIngestMetrics();
  const state = new FakeFleetState();
  const push = new FakePush();
  const connections = new FakeConnections();
  connections.bySite.set(SITE, [connection("conn-secret-7", NOW.getTime() + 3_600_000)]);
  const deps: IngestTelemetryDeps = {
    state,
    connections,
    push,
    policy: new PersistPolicy(),
    clock: new FixedClock(NOW),
    logger,
    metrics,
  };
  return {
    handler: telemetry.createIngestTelemetryHandler(deps),
    logger,
    metrics,
    state,
    push,
    connections,
  };
}

/**
 * A Lambda context with the fields the handler reads.
 *
 * @param remainingMs - Time the invocation has left.
 * @returns The context.
 */
function lambdaContext(remainingMs = 10_000): Context {
  return {
    awsRequestId: "req-00000003",
    getRemainingTimeInMillis: () => remainingMs,
  } as unknown as Context;
}

/**
 * A queue event of telemetry bodies.
 *
 * @param bodies - The bodies, with their identifiers.
 * @returns The event.
 */
function queueEvent(bodies: { messageId: string; body: string }[]): {
  Records: { messageId: string; body: string }[];
} {
  return { Records: bodies };
}

describe("ingest-telemetry handler: the batch contract", () => {
  it("resolves with no batch failure for a valid batch, and fans the samples out once", async () => {
    const h = harness();
    const event = queueEvent([
      { messageId: messageIdOf(1), body: telemetryBody({ robotId: "kali-01" }, 1) },
      { messageId: messageIdOf(2), body: telemetryBody({ robotId: "sim-01" }, 2) },
    ]);

    const response = await h.handler(event, lambdaContext());

    expect(response).toStrictEqual({ batchItemFailures: [] });
    expect(h.push.frames()).toMatchObject([{ type: "fleet.delta", siteId: SITE }]);
    expect(h.metrics.total("TelemetryAccepted")).toBe(2);
    expect(h.metrics.total("TelemetryPersisted")).toBe(2);
    expect(h.metrics.total("FanOutSent")).toBe(1);
    expect(h.metrics.records.map((record) => record.name).sort()).toStrictEqual([
      "BatchSize",
      "IngestLatencyMs",
    ]);
  });

  it("returns only the failing robot's message as a batch item failure", async () => {
    const h = harness();
    h.state.failingObservations.add("sim-02");
    const event = queueEvent([
      { messageId: messageIdOf(1), body: telemetryBody({ robotId: "kali-01" }, 1) },
      { messageId: messageIdOf(2), body: telemetryBody({ robotId: "sim-02" }, 2) },
    ]);

    const response = await h.handler(event, lambdaContext());

    expect(response).toStrictEqual({ batchItemFailures: [{ itemIdentifier: messageIdOf(2) }] });
  });

  it("never fails the batch for a rejected message: it is counted and logged, not redelivered", async () => {
    const h = harness();
    const event = queueEvent([
      { messageId: messageIdOf(1), body: telemetryBody({ robotId: "kali-01", battery: 101 }, 1) },
      { messageId: messageIdOf(2), body: "{not json" },
    ]);

    const response = await h.handler(event, lambdaContext());

    expect(response).toStrictEqual({ batchItemFailures: [] });
    expect(
      h.metrics.counts
        .filter((count) => count.name === "TelemetryRejected")
        .map((count) => count.dimension),
    ).toStrictEqual([
      { name: "reason", value: "NOT_JSON" },
      { name: "reason", value: "SCHEMA" },
    ]);
  });

  it("refuses an event that is not a queue batch, logs its name only, and rethrows so the batch is retried", async () => {
    const h = harness();

    await expect(h.handler({ Records: "not-a-list" }, lambdaContext())).rejects.toThrow();

    expect(h.logger.entries).toHaveLength(1);
    expect(h.logger.entries[0]).toMatchObject({
      level: "error",
      message: "unhandled error",
      attributes: { errorName: "ZodError" },
    });
    expect(h.metrics.publishes).toBe(1);
    expect(h.state.observations).toStrictEqual([]);
  });

  it("publishes its metrics once per invocation and removes the correlation id it appended", async () => {
    const h = harness();

    await h.handler(queueEvent([]), lambdaContext());

    expect(h.metrics.publishes).toBe(1);
    expect(h.logger.keys.has("correlationId")).toBe(false);
    expect(h.logger.entries).toMatchObject([
      { level: "info", message: "telemetry batch", attributes: { batchSize: 0, redelivered: 0 } },
    ]);
  });
});

describe("ingest-telemetry handler: log hygiene", () => {
  it("never logs the body, the payload, the connection identifier or a store error message", async () => {
    const h = harness();
    h.state.failingObservations.add("kali-01");
    const body = telemetryBody({ robotId: "kali-01" }, 1);
    const payloadBase64 = (JSON.parse(body) as { payloadBase64: string }).payloadBase64;

    await h.handler(queueEvent([{ messageId: messageIdOf(1), body }]), lambdaContext());

    const text = h.logger.text();
    expect(text).not.toContain(payloadBase64);
    expect(text).not.toContain("conn-secret-7");
    expect(text).not.toContain("store unavailable");
    expect(text).toContain("telemetry state write failed");
  });

  it("logs the robot of a rejection, and no payload of it", async () => {
    const h = harness();
    const body = telemetryBody({ robotId: "kali-01", battery: 101, state: "SECRET-VALUE" }, 1);

    await h.handler(queueEvent([{ messageId: messageIdOf(1), body }]), lambdaContext());

    expect(
      h.logger.entries.find((entry) => entry.message === "telemetry rejected")?.attributes,
    ).toStrictEqual({
      reason: "SCHEMA",
      robotId: "kali-01",
    });
    expect(h.logger.text()).not.toContain("SECRET-VALUE");
  });
});

describe("ingest-telemetry module", () => {
  it("builds the production handler at load without any call, from a valid environment", () => {
    expect(typeof telemetry.handler).toBe("function");
  });
});
