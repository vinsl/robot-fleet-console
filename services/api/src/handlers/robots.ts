/**
 * Lambda entry point of the `robots` function: registration and retirement of robots, invoked directly
 * with IAM.
 *
 * The handler is thin. It validates the event, dispatches to the domain, validates what the domain
 * returns, and publishes the metrics. Module scope holds the one-time wiring: the environment is parsed
 * (failing closed), and the SDK clients are built, none of them making a call.
 *
 * The X-Ray tracer wraps the DynamoDB and Kinesis Video clients only. The IoT clients are never wrapped,
 * and the handler is never wrapped with `captureLambdaHandler`: a traced response would copy the
 * certificate and the private key of a kit into X-Ray (ADR 0029).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IoTClient } from "@aws-sdk/client-iot";
import { IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import { KinesisVideoClient } from "@aws-sdk/client-kinesis-video";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MetricUnit, type Metrics } from "@aws-lambda-powertools/metrics";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import {
  AdminInvokeEventSchema,
  RegisterInvokeResultSchema,
  RetireInvokeResultSchema,
  uuidv7,
  type AdminInvokeEvent,
  type AdminInvokeResult,
  type CorrelationId,
} from "@mfc/protocol";
import type { Context } from "aws-lambda";
import { z } from "zod";
import { issuesOf } from "../adapters/http";
import { AwsIot } from "../adapters/iot";
import { AwsKvs } from "../adapters/kvs";
import { DynamoDbAudit } from "../adapters/dynamodb-audit";
import { DynamoDbRegistry } from "../adapters/dynamodb-registry";
import { safeErrorFields } from "../domain/safe-error";
import { loadRobotsEnv } from "../config/env";
import {
  createObservability,
  handlerLogger,
  type HandlerLogger,
  type Observability,
} from "../observability";
import type { DomainMetrics, InvocationContext, RobotsDeps } from "../domain/ports";
import { registerRobot } from "../domain/robots/register";
import { PROBLEM_DETAILS, problemResult } from "../domain/robots/problems";
import { retireRobot } from "../domain/robots/retire";

/** Attempts per SDK call. A registration retries a transient failure, and a retirement is idempotent. */
const SDK_MAX_ATTEMPTS = 3;

/** Time the SDK waits for a response before it gives up, in milliseconds. */
const SDK_REQUEST_TIMEOUT_MS = 5000;

/** Time the SDK waits for a connection to open, in milliseconds. */
const SDK_CONNECTION_TIMEOUT_MS = 2000;

/** Keys this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEYS = ["correlationId", "action", "actor", "robotId", "siteId"];

export type { HandlerLogger } from "../observability";

/** Metrics of the handler: the business counters, published once per invocation. */
export interface HandlerMetrics extends DomainMetrics {
  /** Publishes the counters of the invocation. */
  publishStoredMetrics(): void;
}

/** Tracer of the handler: annotations only, the clients are wrapped at module scope. */
export interface HandlerTracer {
  /** Adds an annotation to the current segment, searchable in X-Ray. */
  putAnnotation(key: string, value: string): void;
}

/** Everything the handler needs. Production passes the Powertools utilities and the AWS adapters. */
export interface RobotsHandlerDeps {
  /** Logger. */
  readonly logger: HandlerLogger;
  /** Metrics. */
  readonly metrics: HandlerMetrics;
  /** Tracer. */
  readonly tracer: HandlerTracer;
  /** Ports and configuration of the domain. */
  readonly ports: Omit<RobotsDeps, "logger" | "metrics">;
}

/** The Lambda handler of the `robots` function. */
export type RobotsHandler = (event: unknown, context: Context) => Promise<AdminInvokeResult>;

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - Logger, metrics, tracer and the domain ports.
 * @returns The Lambda handler. Every outcome is returned, never thrown: a refusal is a `400`, a bug is a
 * `500` with no internal text.
 */
export function createRobotsHandler(deps: RobotsHandlerDeps): RobotsHandler {
  const { logger, metrics, tracer, ports } = deps;
  const domain: RobotsDeps = { ...ports, logger, metrics };

  /**
   * Runs the action of a valid event and checks its result against the shared schema.
   *
   * @param event - The validated event.
   * @param invocation - The invocation context of the domain.
   * @returns The validated result, or an internal failure when the domain returned something malformed.
   */
  async function dispatch(
    event: AdminInvokeEvent,
    invocation: InvocationContext,
  ): Promise<AdminInvokeResult> {
    if (event.action === "robots.register") {
      const checked = RegisterInvokeResultSchema.safeParse(
        await registerRobot(domain, event.body, invocation),
      );
      return checked.success
        ? checked.data
        : refusedResult(checked.error, event.action, invocation.correlationId);
    }
    const checked = RetireInvokeResultSchema.safeParse(
      await retireRobot(domain, event.body, invocation),
    );
    return checked.success
      ? checked.data
      : refusedResult(checked.error, event.action, invocation.correlationId);
  }

  /**
   * Turns a result the domain returned against its own contract into an internal failure. The paths of
   * the issues are logged, never their values: the result of a registration carries the private key.
   *
   * @param error - The validation error of the result.
   * @param action - The action, for the log.
   * @param correlationId - The correlation identifier of the invocation.
   * @returns The internal failure to return to the caller.
   */
  function refusedResult(
    error: z.ZodError,
    action: string,
    correlationId: CorrelationId,
  ): AdminInvokeResult {
    logger.error("result refused by schema", { action, issues: issuesOf(error.issues) });
    return problemResult("internal", PROBLEM_DETAILS.internal, correlationId);
  }

  return async (event: unknown, context: Context): Promise<AdminInvokeResult> => {
    logger.addContext(context);
    const parsed = AdminInvokeEventSchema.safeParse(event);
    const correlationId: CorrelationId =
      parsed.success && parsed.data.correlationId !== undefined
        ? parsed.data.correlationId
        : domain.ids.uuidv7();
    logger.appendKeys({ correlationId });

    try {
      if (!parsed.success) {
        logger.warn("admin event refused", { issues: issuesOf(parsed.error.issues) });
        metrics.count("RobotRegistrationRefused");
        return problemResult("invalid-request", PROBLEM_DETAILS.invalidRequest, correlationId);
      }

      const adminEvent = parsed.data;
      logger.appendKeys({
        action: adminEvent.action,
        actor: adminEvent.actor,
        robotId: adminEvent.body.robotId,
        siteId: adminEvent.body.siteId,
      });
      tracer.putAnnotation("action", adminEvent.action);
      tracer.putAnnotation("robotId", adminEvent.body.robotId);

      return await dispatch(adminEvent, {
        correlationId,
        actor: adminEvent.actor,
        deadline: { remainingMs: () => context.getRemainingTimeInMillis() },
      });
    } catch (error) {
      // The message of an unexpected error can carry an ARN or a request fragment: only its name is logged.
      logger.error("unhandled error", safeErrorFields(error));
      return problemResult("internal", PROBLEM_DETAILS.internal, correlationId);
    } finally {
      metrics.publishStoredMetrics();
      // The keys belong to this invocation: a warm container must not carry them into the next one.
      logger.removeKeys(INVOCATION_LOG_KEYS);
    }
  };
}

/**
 * Adapts the Powertools metrics to the handler's counter interface.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The counter, which adds one count per call.
 */
function powertoolsCounter(metrics: Metrics): HandlerMetrics {
  return {
    count: (name) => {
      metrics.addMetric(name, MetricUnit.Count, 1);
    },
    publishStoredMetrics: () => {
      metrics.publishStoredMetrics();
    },
  };
}

/**
 * Keeps the tracer's annotation method as the handler's own interface.
 *
 * @param tracer - The Powertools tracer.
 * @returns The tracer narrowed to annotations.
 */
function annotationsOf(tracer: Tracer): HandlerTracer {
  return {
    putAnnotation: (key, value) => {
      tracer.putAnnotation(key, value);
    },
  };
}

/**
 * Wires the production handler: the environment, the observability, the SDK clients and the adapters.
 * Runs once per cold start. A missing or malformed environment variable throws here, so the function
 * never serves a request with a wrong configuration.
 */
function buildProductionHandler(observability: Observability): RobotsHandler {
  const env = loadRobotsEnv(process.env);
  const clientConfig = {
    region: env.AWS_REGION,
    maxAttempts: SDK_MAX_ATTEMPTS,
    requestHandler: {
      requestTimeout: SDK_REQUEST_TIMEOUT_MS,
      connectionTimeout: SDK_CONNECTION_TIMEOUT_MS,
    },
  };

  // The document client drops undefined attributes, so optional fields are simply absent in the table.
  const dynamo = DynamoDBDocumentClient.from(
    observability.tracer.captureAWSv3Client(new DynamoDBClient(clientConfig)),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const kinesis = observability.tracer.captureAWSv3Client(new KinesisVideoClient(clientConfig));
  const iot = new IoTClient(clientConfig);
  // A single attempt: a retried certificate creation would mint a second key pair (ADR 0029).
  const iotNoRetry = new IoTClient({ ...clientConfig, maxAttempts: 1 });
  const iotData = new IoTDataPlaneClient({
    ...clientConfig,
    endpoint: `https://${env.IOT_DATA_ENDPOINT}`,
  });

  return createRobotsHandler({
    logger: handlerLogger(observability.logger),
    metrics: powertoolsCounter(observability.metrics),
    tracer: annotationsOf(observability.tracer),
    ports: {
      registry: new DynamoDbRegistry(dynamo, env.FLEET_TABLE_NAME),
      audit: new DynamoDbAudit(dynamo, env.EVENTS_TABLE_NAME),
      iot: new AwsIot({ iot, iotNoRetry, iotData }),
      kvs: new AwsKvs(kinesis),
      clock: { now: () => new Date() },
      ids: { uuidv7: () => uuidv7() },
      config: {
        region: env.AWS_REGION,
        iotEndpoint: env.IOT_DATA_ENDPOINT,
        credentialsEndpoint: env.IOT_CREDENTIALS_ENDPOINT,
        resourceTags: env.RESOURCE_TAGS,
      },
    },
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: RobotsHandler = buildProductionHandler(createObservability("robots"));
