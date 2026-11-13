/**
 * Robots handler: the event contract and its denied-access fixtures, the outcomes of each action, the
 * failures that must not leak, and the logs, metrics and trace the handler writes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Uuidv7Schema, type RegisterInvokeResult } from "@mfc/protocol";
import type { Context } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerRobot } from "../../src/domain/robots/register";
import { PROBLEM_DETAILS } from "../../src/domain/robots/problems";
import type * as RobotsModule from "../../src/handlers/robots";
import type {
  HandlerLogger,
  HandlerMetrics,
  HandlerTracer,
  RobotsHandler,
} from "../../src/handlers/robots";
import { FAKE_KEY_BODY } from "../fakes/fake-iot";
import { RecordingLogger, RecordingMetrics } from "../fakes/recording";
import { createWorld, REQUEST, TEST_CORRELATION_ID, type World } from "../fakes/world";

vi.mock("../../src/domain/robots/register", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/domain/robots/register")>();
  return { ...actual, registerRobot: vi.fn(actual.registerRobot) };
});

/** The fixtures of refused admin events, shared with the protocol package. */
const INVALID_EVENTS_DIR = fileURLToPath(
  new URL("../../../../packages/protocol/fixtures/admin-invoke-event/invalid/", import.meta.url),
);

/** Values that stand in for an environment the module reads at load time. Fake, and not real resources. */
const TEST_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  IOT_DATA_ENDPOINT: "abc123-ats.iot.eu-west-3.amazonaws.com",
  IOT_CREDENTIALS_ENDPOINT: "abc123.credentials.iot.eu-west-3.amazonaws.com",
  RESOURCE_TAGS: JSON.stringify({
    project: "mfc",
    env: "demo",
    component: "robots",
    owner: "vincent",
  }),
};

/** The loaded handler module, imported once the environment is set. */
let robots: typeof RobotsModule;

beforeAll(async () => {
  for (const [name, value] of Object.entries(TEST_ENVIRONMENT)) {
    vi.stubEnv(name, value);
  }
  robots = await import("../../src/handlers/robots");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** Logger that keeps its entries and the keys appended to it. */
class HandlerLog extends RecordingLogger implements HandlerLogger {
  /** Keys currently appended, as the logger would print them. */
  readonly keys = new Map<string, unknown>();

  /** The Lambda context fields are not under test here. */
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

/** Metrics that also count how many times they were published. */
class HandlerCounter extends RecordingMetrics implements HandlerMetrics {
  /** Number of publications, one per invocation. */
  publishes = 0;

  /** Counts one publication. */
  publishStoredMetrics(): void {
    this.publishes += 1;
  }
}

/** Tracer that keeps its annotations. */
class HandlerTrace implements HandlerTracer {
  /** Annotations by key. */
  readonly annotations = new Map<string, string>();

  /** @param key - Annotation key. @param value - Annotation value. */
  putAnnotation(key: string, value: string): void {
    this.annotations.set(key, value);
  }
}

/** A handler under test with the observers it writes to. */
interface Harness {
  readonly world: World;
  readonly handler: RobotsHandler;
  readonly logger: HandlerLog;
  readonly metrics: HandlerCounter;
  readonly tracer: HandlerTrace;
}

/**
 * Builds a handler over a fresh world of fakes.
 *
 * @returns The handler and what it writes to.
 */
function harness(): Harness {
  const world = createWorld();
  const logger = new HandlerLog();
  const metrics = new HandlerCounter();
  const tracer = new HandlerTrace();
  const handler = robots.createRobotsHandler({
    logger,
    metrics,
    tracer,
    ports: {
      registry: world.deps.registry,
      iot: world.deps.iot,
      kvs: world.deps.kvs,
      audit: world.deps.audit,
      clock: world.deps.clock,
      ids: world.deps.ids,
      config: world.deps.config,
    },
  });
  return { world, handler, logger, metrics, tracer };
}

/**
 * @param remainingMs - Time the invocation has left.
 * @returns A Lambda context with the fields the handler reads.
 */
function lambdaContext(remainingMs = 60_000): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "mfc-demo-robots",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-robots",
    memoryLimitInMB: "256",
    awsRequestId: "req-00000001",
    logGroupName: "/aws/lambda/mfc-demo-robots",
    logStreamName: "2026/11/02/test",
    getRemainingTimeInMillis: () => remainingMs,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

/** A valid registration event of the reference robot. */
const REGISTER_EVENT = {
  source: "mfc.admin",
  action: "robots.register",
  actor: "vincent",
  correlationId: TEST_CORRELATION_ID,
  body: REQUEST,
};

/** A valid retirement event of the reference robot. */
const RETIRE_EVENT = {
  source: "mfc.admin",
  action: "robots.retire",
  actor: "vincent",
  correlationId: TEST_CORRELATION_ID,
  body: { robotId: "kali-01", siteId: "paris-01" },
};

/** The denied-access fixtures, one entry per file, in name order. */
const INVALID_EVENTS = readdirSync(INVALID_EVENTS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    event: JSON.parse(readFileSync(`${INVALID_EVENTS_DIR}${name}`, "utf8")) as unknown,
  }));

/**
 * Spies on the registry and audit methods, which a refused event must never reach.
 *
 * @param world - The world whose ports are spied on.
 * @returns The spies, one per method.
 */
function registryAndAuditSpies(world: World): unknown[] {
  return [
    vi.spyOn(world.registry, "reserve"),
    vi.spyOn(world.registry, "get"),
    vi.spyOn(world.registry, "replace"),
    vi.spyOn(world.audit, "write"),
  ];
}

describe("robots handler: outcomes", () => {
  it("registers a robot with 201, returns the kit, and counts the registration once", async () => {
    const { handler, world, metrics } = harness();

    const result = await handler(REGISTER_EVENT, lambdaContext());

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      body: { robot: { robotId: "kali-01", status: "ACTIVE" } },
    });
    expect(metrics.countOf("RobotRegistered")).toBe(1);
    expect(metrics.publishes).toBe(1);
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "robots.register",
      result: "SUCCEEDED",
      correlationId: TEST_CORRELATION_ID,
    });
  });

  it("retires a registered robot with 200, then answers a repeat as already retired", async () => {
    const { handler } = harness();
    await handler(REGISTER_EVENT, lambdaContext());

    const first = await handler(RETIRE_EVENT, lambdaContext());
    const repeat = await handler(RETIRE_EVENT, lambdaContext());

    expect(first).toMatchObject({ ok: true, status: 200, body: { alreadyRetired: false } });
    expect(repeat).toMatchObject({ ok: true, status: 200, body: { alreadyRetired: true } });
  });

  it("generates a lowercase UUIDv7 correlation id when the event carries none", async () => {
    const { handler, world } = harness();
    const withoutCorrelation = {
      source: REGISTER_EVENT.source,
      action: REGISTER_EVENT.action,
      actor: REGISTER_EVENT.actor,
      body: REGISTER_EVENT.body,
    };

    await handler(withoutCorrelation, lambdaContext());

    expect(Uuidv7Schema.safeParse(world.audit.records[0]?.correlationId).success).toBe(true);
  });

  it("tags the trace with the action and the robot, and removes the log keys when the invocation ends", async () => {
    const { handler, logger, tracer } = harness();

    await handler(REGISTER_EVENT, lambdaContext());

    expect(tracer.annotations.get("action")).toBe("robots.register");
    expect(tracer.annotations.get("robotId")).toBe("kali-01");
    expect(logger.keys.size).toBe(0);
  });
});

describe("robots handler: denied access", () => {
  it("found the fixtures of refused events", () => {
    expect(INVALID_EVENTS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(INVALID_EVENTS.map((fixture) => [fixture.name, fixture.event] as const))(
    "refuses %s with 400 before any call to the registry, the IoT or the video service",
    async (_name, event) => {
      const { handler, world, logger, metrics } = harness();
      const spies = registryAndAuditSpies(world);

      const result = await handler(event, lambdaContext());

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        problem: {
          type: "urn:mfc:problem:invalid-request",
          title: "Invalid request",
          status: 400,
          detail: PROBLEM_DETAILS.invalidRequest,
        },
      });
      expect(result.ok ? false : Uuidv7Schema.safeParse(result.problem.correlationId).success).toBe(
        true,
      );
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(world.calls).toStrictEqual([]);
      expect(world.iot.things.size).toBe(0);
      expect(world.kvs.channels.size).toBe(0);
      expect(metrics.countOf("RobotRegistrationRefused")).toBe(1);
      expect(metrics.publishes).toBe(1);

      const refusal = logger.entries.find((entry) => entry.message === "admin event refused");
      expect(refusal).toBeDefined();
      const issues = (refusal?.attributes as { issues?: unknown[] } | undefined)?.issues ?? [];
      for (const issue of issues) {
        expect(Object.keys(issue as object).sort()).toStrictEqual(["code", "path"]);
      }
      expect(logger.text()).not.toContain("vincent");
    },
  );

  it("refuses an event that is not an object, with 400", async () => {
    const { handler } = harness();

    const result = await handler("not an event", lambdaContext());

    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe("robots handler: failures", () => {
  it("returns 500 with no internal text when the domain throws", async () => {
    const { handler, world, logger, metrics } = harness();
    world.registry.gate.fail(
      "reserve",
      new Error("leaked arn:aws:iot:eu-west-3:123456789012:cert/secret-id"),
    );

    const result = await handler(REGISTER_EVENT, lambdaContext());

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      problem: { type: "urn:mfc:problem:internal", detail: PROBLEM_DETAILS.internal },
    });
    expect(JSON.stringify(result)).not.toContain("leaked");
    expect(
      logger.entries.find((entry) => entry.message === "unhandled error")?.attributes,
    ).toStrictEqual({
      errorName: "Error",
    });
    expect(logger.text()).not.toContain("secret-id");
    expect(metrics.publishes).toBe(1);
  });

  it("returns 500 when the domain returns a result that breaks its contract, and logs only the paths", async () => {
    const { handler, logger, metrics } = harness();
    const malformed = {
      ok: true,
      status: 201,
      body: { robot: {}, kit: { privateKeyPem: "FAKE-KEY-MATERIAL" } },
    } as unknown as RegisterInvokeResult;
    vi.mocked(registerRobot).mockResolvedValueOnce(malformed);

    const result = await handler(REGISTER_EVENT, lambdaContext());

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      problem: { type: "urn:mfc:problem:internal" },
    });
    expect(JSON.stringify(result)).not.toContain("FAKE-KEY-MATERIAL");
    const refusal = logger.entries.find((entry) => entry.message === "result refused by schema");
    expect(refusal?.attributes).toMatchObject({ action: "robots.register" });
    expect(logger.text()).not.toContain("FAKE-KEY-MATERIAL");
    expect(metrics.publishes).toBe(1);
  });

  it("never logs key material during a successful registration", async () => {
    const { handler, logger } = harness();

    await handler(REGISTER_EVENT, lambdaContext());

    expect(logger.text()).not.toContain("PRIVATE");
    expect(logger.text()).not.toContain("BEGIN CERTIFICATE");
    expect(logger.text()).not.toContain(FAKE_KEY_BODY);
  });
});
