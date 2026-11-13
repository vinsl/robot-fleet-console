/**
 * Lambda entry point of the `ws-disconnect` function: the `$disconnect` route of the WebSocket API.
 *
 * API Gateway ignores the result of `$disconnect`, so the function only has to remove the record. A missing record
 * is success. A failed removal throws: the record then expires by its TTL, which is the designed fallback.
 */
import type { Context } from "aws-lambda";
import { z } from "zod";
import { DynamoDbWsSession } from "../adapters/dynamodb-ws-session";
import { createDynamoDocumentClient } from "../adapters/clients";
import { loadWsDisconnectEnv } from "../config/env";
import { safeErrorFields } from "../domain/safe-error";
import type { WsMetricsPort } from "../domain/ws/metrics";
import { ConnectionIdSchema } from "../domain/ws/session";
import type { WsSessionStore } from "../domain/ws/token";
import {
  createObservability,
  handlerLogger,
  wsMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";

/** The part of the `$disconnect` proxy event this function reads. */
const DisconnectEventSchema = z.object({
  requestContext: z.object({ connectionId: ConnectionIdSchema }),
});

/** Result of an invocation: the status only. */
export interface WsDisconnectResult {
  readonly statusCode: 200 | 400;
}

/** The Lambda handler of the `ws-disconnect` function. */
export type WsDisconnectHandler = (event: unknown, context: Context) => Promise<WsDisconnectResult>;

/** Everything the handler needs. */
export interface WsDisconnectDeps {
  readonly store: WsSessionStore;
  readonly logger: HandlerLogger;
  readonly metrics: WsMetricsPort;
}

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/**
 * Builds the handler over its ports.
 *
 * @param deps - The store and the observers.
 * @returns The Lambda handler. It returns 200 after the removal, 400 for an unreadable event, and throws on a
 * store failure.
 */
export function createWsDisconnectHandler(deps: WsDisconnectDeps): WsDisconnectHandler {
  return async (event, context) => {
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: context.awsRequestId });
    try {
      const parsed = DisconnectEventSchema.safeParse(event);
      if (!parsed.success) {
        deps.logger.warn("disconnect event unreadable");
        return { statusCode: 400 };
      }
      await deps.store.remove(parsed.data.requestContext.connectionId);
      deps.metrics.count("WsDisconnected");
      return { statusCode: 200 };
    } catch (error) {
      deps.logger.error("disconnect cleanup failed", safeErrorFields(error));
      throw error;
    } finally {
      deps.metrics.publishStoredMetrics();
      deps.logger.removeKeys([INVOCATION_LOG_KEY]);
    }
  };
}

/**
 * Wires the production handler. Runs once per cold start; a malformed environment throws here.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): WsDisconnectHandler {
  const env = loadWsDisconnectEnv(process.env);
  const store = new DynamoDbWsSession(
    createDynamoDocumentClient(env.AWS_REGION, observability.tracer),
    env.CONNECTIONS_TABLE_NAME,
  );
  return createWsDisconnectHandler({
    store,
    logger: handlerLogger(observability.logger),
    metrics: wsMetricsOf(observability.metrics),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: WsDisconnectHandler = buildProductionHandler(
  createObservability("ws-disconnect"),
);
