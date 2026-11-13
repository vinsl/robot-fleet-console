/**
 * The complete set of fakes and dependencies for one test of the robot use cases, and the fixtures they share.
 */
import type { Actor, CorrelationId, RegisterRobotRequest } from "@mfc/protocol";
import type { RobotsConfig, InvocationContext, RobotsDeps } from "../../src/domain/ports";
import { RobotRecordSchema, type RobotRecord } from "../../src/domain/robots/registry";
import { FakeAudit, FakeKvs } from "./fake-kvs-audit";
import { FakeIot } from "./fake-iot";
import { FakeRegistry } from "./fake-registry";
import { FixedClock, ScriptedDeadline, SequentialIds } from "./fixed";
import { RecordingLogger, RecordingMetrics } from "./recording";

/** Instant every test starts at. */
export const START_TIME = new Date("2026-11-02T10:00:00.000Z");

/** Configuration of the function in tests: the demo region and fake endpoints. */
export const TEST_CONFIG: RobotsConfig = {
  region: "eu-west-3",
  iotEndpoint: "abc123-ats.iot.eu-west-3.amazonaws.com",
  credentialsEndpoint: "abc123.credentials.iot.eu-west-3.amazonaws.com",
  resourceTags: { project: "mfc", env: "demo", component: "robots", owner: "vincent" },
};

/** Declared caller of the tests. */
export const TEST_ACTOR: Actor = "vincent";

/** Correlation identifier of the default invocation. */
export const TEST_CORRELATION_ID: CorrelationId = "corr-00000001";

/** A valid registration request for the reference robot. */
export const REQUEST: RegisterRobotRequest = {
  robotId: "kali-01",
  siteId: "paris-01",
  name: "Kali 01",
  type: "KALI",
  designDate: "2026-11-02",
  simulated: true,
};

/** Everything a test needs: the dependencies, the fakes behind them, and the invocation factory. */
export interface World {
  readonly deps: RobotsDeps;
  /** Shared log of the IoT and video calls, in order. */
  readonly calls: string[];
  readonly registry: FakeRegistry;
  readonly iot: FakeIot;
  readonly kvs: FakeKvs;
  readonly audit: FakeAudit;
  readonly logger: RecordingLogger;
  readonly metrics: RecordingMetrics;
  readonly clock: FixedClock;
  readonly deadline: ScriptedDeadline;
  /**
   * @param correlationId - Correlation identifier of the invocation.
   * @returns The invocation context of a test call.
   */
  invocation(correlationId?: CorrelationId): InvocationContext;
}

/**
 * Builds a fresh world.
 *
 * @returns The dependencies and the fakes, all empty.
 */
export function createWorld(): World {
  const calls: string[] = [];
  const registry = new FakeRegistry();
  const iot = new FakeIot(calls);
  const kvs = new FakeKvs(calls);
  const audit = new FakeAudit();
  const logger = new RecordingLogger();
  const metrics = new RecordingMetrics();
  const clock = new FixedClock(START_TIME);
  const deadline = new ScriptedDeadline(60_000);
  const deps: RobotsDeps = {
    registry,
    iot,
    kvs,
    audit,
    clock,
    ids: new SequentialIds(),
    logger,
    metrics,
    config: TEST_CONFIG,
  };
  return {
    deps,
    calls,
    registry,
    iot,
    kvs,
    audit,
    logger,
    metrics,
    clock,
    deadline,
    invocation: (correlationId: CorrelationId = TEST_CORRELATION_ID): InvocationContext => ({
      correlationId,
      actor: TEST_ACTOR,
      deadline,
    }),
  };
}

/**
 * A registry record of the reference robot, validated by the schema.
 *
 * @param overrides - Fields to replace.
 * @returns The record, `ACTIVE` with no certificate unless overridden.
 */
export function recordOf(overrides: Partial<RobotRecord> = {}): RobotRecord {
  const timestamp = START_TIME.toISOString();
  return RobotRecordSchema.parse({
    ...REQUEST,
    thingName: "mfc-demo-kali-01",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    certificates: [],
    lastCorrelationId: TEST_CORRELATION_ID,
    ...overrides,
  });
}
