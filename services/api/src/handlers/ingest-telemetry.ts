/**
 * Lambda entry point of the `ingest-telemetry` function: the telemetry queue, one batch per invocation.
 *
 * The handler is thin. It validates the queue event, runs the batch in the domain, publishes the counts as
 * metrics, and returns the message identifiers that must be redelivered. Module scope holds the one-time
 * wiring: the environment is parsed (failing closed), and the SDK clients and the warm-container persist
 * policy are built, none of them making a call.
 *
 * The X-Ray tracer wraps the DynamoDB and the management clients. The handler itself is never wrapped with
 * `captureLambdaHandler`, so no body is copied into a trace.
 */
import type { Context, SQSBatchResponse } from "aws-lambda";
import { z } from "zod";
import { loadIngestTelemetryEnv } from "../config/env";
import { DynamoDbConnections } from "../adapters/dynamodb-connections";
import { DynamoDbFleetState } from "../adapters/dynamodb-fleet-state";
import { ApiGatewayPush } from "../adapters/apigw-push";
import { createDynamoDocumentClient, createManagementClient } from "../adapters/clients";
import { PersistPolicy } from "../domain/live/persist-policy";
import type { FleetStatePort, ConnectionsPort, PushPort } from "../domain/live/ports";
import { processTelemetryBatch, type BatchStats } from "../domain/ingest/process-telemetry";
import { IngestRejectReasonSchema } from "../domain/ingest/classify";
import type { IngestMetricsPort } from "../domain/ingest/metrics";
import type { Clock } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import {
  createObservability,
  handlerLogger,
  ingestMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";

/** Largest body a queue message can carry (the SQS limit). Larger bodies are malformed events. */
const MAX_BODY_LENGTH = 262_144;

/** Largest batch the event source mapping delivers. Bounds the work of one invocation. */
const MAX_RECORDS = 1000;

/** The queue event as the runtime delivers it, reduced to the fields the function reads. */
const SqsBatchEventSchema = z.object({
  Records: z
    .array(
      z.object({
        messageId: z.string().min(1).max(80),
        body: z.string().max(MAX_BODY_LENGTH),
      }),
    )
    .max(MAX_RECORDS),
});

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/** The Lambda handler of the `ingest-telemetry` function. */
export type IngestTelemetryHandler = (
  event: unknown,
  context: Context,
) => Promise<SQSBatchResponse>;

/** Everything the handler needs. Production passes the AWS adapters and the Powertools utilities. */
export interface IngestTelemetryDeps {
  readonly state: FleetStatePort;
  readonly connections: ConnectionsPort;
  readonly push: PushPort;
  readonly policy: PersistPolicy;
  readonly clock: Clock;
  readonly logger: HandlerLogger;
  readonly metrics: IngestMetricsPort;
}

/**
 * Adds a counted metric when the amount is positive, so that zero-valued counters stay out of the output.
 *
 * @param metrics - The metrics sink.
 * @param name - The metric.
 * @param amount - The occurrences of the invocation.
 */
function addCount(
  metrics: IngestMetricsPort,
  name: Parameters<IngestMetricsPort["count"]>[0],
  amount: number,
): void {
  if (amount > 0) {
    metrics.count(name, undefined, amount);
  }
}

/**
 * Publishes the counts of a batch. Each rejection reason is one dimension of the rejection metric.
 *
 * @param metrics - The metrics sink.
 * @param stats - The counts of the batch.
 */
function publishStats(metrics: IngestMetricsPort, stats: BatchStats): void {
  metrics.record("BatchSize", stats.batchSize);
  addCount(metrics, "TelemetryAccepted", stats.accepted);
  for (const reason of IngestRejectReasonSchema.options) {
    const amount = stats.rejected.get(reason) ?? 0;
    if (amount > 0) {
      metrics.count("TelemetryRejected", { name: "reason", value: reason }, amount);
    }
  }
  addCount(metrics, "TelemetrySuperseded", stats.superseded);
  addCount(metrics, "TelemetryStale", stats.stale);
  addCount(metrics, "TelemetryPersisted", stats.persisted);
  addCount(metrics, "TelemetryRefused", stats.refused);
  addCount(metrics, "StaleBootRefused", stats.staleBootRefused);
  addCount(metrics, "TelemetryPersistFailed", stats.persistFailed);
  addCount(metrics, "TelemetryDeferred", stats.deferred);
  addCount(metrics, "FanOutSent", stats.fanOutSent);
  addCount(metrics, "FanOutGone", stats.fanOutGone);
  addCount(metrics, "FanOutFailed", stats.fanOutFailed);
  addCount(metrics, "FanOutExpired", stats.fanOutExpired);
  addCount(metrics, "FanOutTruncated", stats.fanOutTruncated);
  addCount(metrics, "FanOutListFailed", stats.fanOutListFailed);
  if (stats.ingestLatencyMs !== undefined) {
    metrics.record("IngestLatencyMs", stats.ingestLatencyMs);
  }
}

/**
 * Builds the handler over its ports.
 *
 * @param deps - The ports, the policy and the observers the handler writes to.
 * @returns The Lambda handler. It resolves with the batch failures; an invalid event or an unexpected error is
 * logged by name and thrown, so the queue redelivers the whole batch.
 */
export function createIngestTelemetryHandler(deps: IngestTelemetryDeps): IngestTelemetryHandler {
  return async (event, context) => {
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: context.awsRequestId });
    try {
      const batch = SqsBatchEventSchema.parse(event);
      const result = await processTelemetryBatch(batch.Records, {
        state: deps.state,
        connections: deps.connections,
        push: deps.push,
        policy: deps.policy,
        clock: deps.clock,
        logger: deps.logger,
        deadline: { remainingMs: () => context.getRemainingTimeInMillis() },
      });
      publishStats(deps.metrics, result.stats);
      deps.logger.info("telemetry batch", {
        batchSize: result.stats.batchSize,
        accepted: result.stats.accepted,
        persisted: result.stats.persisted,
        refused: result.stats.refused,
        stale: result.stats.stale,
        superseded: result.stats.superseded,
        deferred: result.stats.deferred,
        persistFailed: result.stats.persistFailed,
        fanOutSent: result.stats.fanOutSent,
        fanOutGone: result.stats.fanOutGone,
        fanOutFailed: result.stats.fanOutFailed,
        fanOutListFailed: result.stats.fanOutListFailed,
        redelivered: result.failedMessageIds.length,
      });
      return {
        batchItemFailures: result.failedMessageIds.map((itemIdentifier) => ({ itemIdentifier })),
      };
    } catch (error) {
      // The message of an unexpected error can carry a payload fragment: only its name is logged.
      deps.logger.error("unhandled error", safeErrorFields(error));
      throw error;
    } finally {
      deps.metrics.publishStoredMetrics();
      deps.logger.removeKeys([INVOCATION_LOG_KEY]);
    }
  };
}

/**
 * Wires the production handler. Runs once per cold start: a missing or malformed environment variable throws
 * here, so the function never serves a batch with a wrong configuration.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): IngestTelemetryHandler {
  const env = loadIngestTelemetryEnv(process.env);
  const logger = handlerLogger(observability.logger);
  const clock: Clock = { now: () => new Date() };
  const dynamo = createDynamoDocumentClient(env.AWS_REGION, observability.tracer);
  const management = observability.tracer.captureAWSv3Client(
    createManagementClient(env.WS_MANAGEMENT_ENDPOINT, env.AWS_REGION),
  );
  return createIngestTelemetryHandler({
    state: new DynamoDbFleetState(dynamo, env.FLEET_TABLE_NAME, clock),
    connections: new DynamoDbConnections(dynamo, env.CONNECTIONS_TABLE_NAME),
    push: new ApiGatewayPush(management, logger),
    policy: new PersistPolicy(),
    clock,
    logger,
    metrics: ingestMetricsOf(observability.metrics),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: IngestTelemetryHandler = buildProductionHandler(
  createObservability("ingest-telemetry"),
);
