/**
 * Lambda entry point of the `ingest-events` function: the robot events, acknowledgements and presence notices
 * that the IoT topic rules deliver, one delivery per invocation.
 *
 * The handler is thin. It classifies the delivery, writes one log line and one metric for the outcome, then
 * runs the domain processing: state, history, alerts and the live relay. A rejected delivery is a normal
 * outcome, so it resolves without an error: a retry would deliver the same bytes again. An unexpected error
 * from the store is logged by name and rethrown, so the runtime retries and then dead-letters the event.
 *
 * Module scope holds the one-time wiring: the environment is parsed (failing closed), and the SDK clients are
 * built, none of them making a call.
 */
import type { Context } from "aws-lambda";
import { loadIngestEventsEnv } from "../config/env";
import { DynamoDbAlerts } from "../adapters/dynamodb-alerts";
import { DynamoDbConnections } from "../adapters/dynamodb-connections";
import { DynamoDbFleetState } from "../adapters/dynamodb-fleet-state";
import { DynamoDbHistory } from "../adapters/dynamodb-history";
import { ApiGatewayPush } from "../adapters/apigw-push";
import { createDynamoDocumentClient, createManagementClient } from "../adapters/clients";
import { safeErrorFields } from "../domain/safe-error";
import { classifyDelivery, type IngestOutcome } from "../domain/ingest/classify";
import { processOutcome, type ProcessDeps } from "../domain/ingest/process-event";
import type { IngestMetricsPort } from "../domain/ingest/metrics";
import type { Clock } from "../domain/ports";
import {
  createObservability,
  handlerLogger,
  ingestMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";

export type { IngestDimension, IngestMetricsPort as IngestMetrics } from "../domain/ingest/metrics";

/** Keys this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEYS = ["correlationId"];

/** Everything the handler needs: the logger, the metrics and the ports of the domain processing. */
export interface IngestEventsHandlerDeps extends ProcessDeps {
  /** Logger of the handler, with the per-invocation context keys. */
  readonly logger: HandlerLogger;
}

/** The Lambda handler of the `ingest-events` function. */
export type IngestEventsHandler = (event: unknown, context: Context) => Promise<void>;

/**
 * Writes the log line of an accepted robot event. A heartbeat comes every few seconds, so it is logged at
 * debug and stays out of the default log level.
 *
 * @param logger - The handler logger.
 * @param outcome - The accepted event.
 */
function logEvent(logger: HandlerLogger, outcome: Extract<IngestOutcome, { kind: "event" }>): void {
  const attributes = {
    robotId: outcome.robotId,
    siteId: outcome.siteId,
    kind: outcome.event.kind,
    seq: outcome.event.seq,
    bootId: outcome.event.bootId,
    messageId: outcome.event.messageId,
  };
  if (outcome.event.kind === "HEARTBEAT") {
    logger.debug("robot event", attributes);
  } else {
    logger.info("robot event", attributes);
  }
}

/**
 * Writes the log line of an acknowledgement. The correlation id of the command is appended to every line
 * of the invocation, so the ack can be followed back to the console request.
 *
 * @param logger - The handler logger.
 * @param outcome - The accepted acknowledgement.
 */
function logAck(logger: HandlerLogger, outcome: Extract<IngestOutcome, { kind: "ack" }>): void {
  const { ack } = outcome;
  logger.appendKeys({ correlationId: ack.correlationId });
  logger.info("robot ack", {
    commandId: ack.commandId,
    result: ack.result,
    reason: ack.result === "REJECT" ? ack.reason : undefined,
  });
}

/**
 * Writes the log line of a presence notice. A connection that fails is a warning: it usually means a
 * wrong certificate or a revoked robot, which an operator should see.
 *
 * @param logger - The handler logger.
 * @param outcome - The presence notice.
 */
function logPresence(
  logger: HandlerLogger,
  outcome: Extract<IngestOutcome, { kind: "presence" }>,
): void {
  const attributes = {
    clientId: outcome.clientId,
    eventType: outcome.eventType,
    disconnectReason: outcome.disconnectReason,
    versionNumber: outcome.versionNumber,
  };
  if (outcome.eventType === "connect_failed") {
    logger.warn("presence", attributes);
  } else {
    logger.info("presence", attributes);
  }
}

/**
 * Logs and counts one classified outcome. The log lines carry identifiers and reasons only: never the
 * payload, which is the robot's data, and never a network address.
 *
 * @param logger - The handler logger.
 * @param metrics - The metrics sink.
 * @param outcome - The outcome of the delivery.
 */
function report(logger: HandlerLogger, metrics: IngestMetricsPort, outcome: IngestOutcome): void {
  switch (outcome.kind) {
    case "event":
      metrics.count("RobotMessageAccepted", { name: "channel", value: "events" });
      logEvent(logger, outcome);
      return;
    case "ack":
      metrics.count("RobotMessageAccepted", { name: "channel", value: "ack" });
      logAck(logger, outcome);
      return;
    case "presence":
      metrics.count("PresenceEvent", { name: "eventType", value: outcome.eventType });
      logPresence(logger, outcome);
      return;
    case "rejected":
      metrics.count("RobotMessageRejected", { name: "reason", value: outcome.reason });
      logger.warn("delivery rejected", {
        reason: outcome.reason,
        robotId: outcome.robotId,
        issuePaths: outcome.issuePaths,
      });
      return;
  }
}

/**
 * Builds the handler over its ports.
 *
 * A synchronous failure of classification or reporting is thrown synchronously, which the runtime treats the
 * same as a rejected promise. A failure of the processing rejects the returned promise. Both are logged by
 * name, and the metrics are published once per invocation in either case.
 *
 * @param deps - The ports, the logger and the metrics the handler writes to.
 * @returns The Lambda handler.
 */
export function createIngestEventsHandler(deps: IngestEventsHandlerDeps): IngestEventsHandler {
  const { logger, metrics } = deps;

  const finish = (): void => {
    metrics.publishStoredMetrics();
    // The keys belong to this invocation: a warm container must not carry them into the next one.
    logger.removeKeys(INVOCATION_LOG_KEYS);
  };
  const fail = (error: unknown): never => {
    // The message of an unexpected error can carry a payload fragment: only its name is logged.
    logger.error("unhandled error", safeErrorFields(error));
    finish();
    throw error;
  };

  return (event: unknown, context: Context): Promise<void> => {
    logger.addContext(context);
    let outcome: IngestOutcome;
    try {
      outcome = classifyDelivery(event);
      report(logger, metrics, outcome);
    } catch (error) {
      return fail(error);
    }
    return processOutcome(outcome, deps).then(finish, fail);
  };
}

/**
 * Wires the production handler. Runs once per cold start: a missing or malformed environment variable throws
 * here, so the function never serves a delivery with a wrong configuration.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): IngestEventsHandler {
  const env = loadIngestEventsEnv(process.env);
  const logger = handlerLogger(observability.logger);
  const metrics = ingestMetricsOf(observability.metrics);
  const clock: Clock = { now: () => new Date() };
  const dynamo = createDynamoDocumentClient(env.AWS_REGION, observability.tracer);
  const management = observability.tracer.captureAWSv3Client(
    createManagementClient(env.WS_MANAGEMENT_ENDPOINT, env.AWS_REGION),
  );
  return createIngestEventsHandler({
    logger,
    metrics,
    state: new DynamoDbFleetState(dynamo, env.FLEET_TABLE_NAME, clock),
    alerts: new DynamoDbAlerts(dynamo, {
      fleetTable: env.FLEET_TABLE_NAME,
      eventsTable: env.EVENTS_TABLE_NAME,
    }),
    history: new DynamoDbHistory(dynamo, env.EVENTS_TABLE_NAME),
    connections: new DynamoDbConnections(dynamo, env.CONNECTIONS_TABLE_NAME),
    push: new ApiGatewayPush(management, logger),
    clock,
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: IngestEventsHandler = buildProductionHandler(
  createObservability("ingest-events"),
);
