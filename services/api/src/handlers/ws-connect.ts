/**
 * Lambda entry point of the `ws-connect` function: the `$connect` route of the WebSocket API.
 *
 * The token is checked here, not by an authorizer: the route has no authorizer, and the redemption is the
 * authentication (ADR 0041, D8). The handler returns a bare status: API Gateway refuses the upgrade on any
 * status other than 200, and the body is never sent to the client. The event is never logged: the query
 * string carries the token.
 */
import { DynamoDbWsSession } from "../adapters/dynamodb-ws-session";
import { createDynamoDocumentClient } from "../adapters/clients";
import { loadWsConnectEnv } from "../config/env";
import type { Clock } from "../domain/ports";
import { ConnectionIdSchema } from "../domain/ws/session";
import type { WsMetricsPort } from "../domain/ws/metrics";
import { redeemAndConnect, type ConnectStatus, type WsSessionStore } from "../domain/ws/token";
import { safeErrorFields } from "../domain/safe-error";
import {
  createObservability,
  handlerLogger,
  wsMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";
import { z } from "zod";
import type { Context } from "aws-lambda";

/**
 * The parts of the `$connect` proxy event this function reads. Loose by design: API Gateway owns the rest.
 * Headers are read case-insensitively, since a client may send `Origin` in any case.
 */
const ConnectEventSchema = z.object({
  requestContext: z.object({ connectionId: ConnectionIdSchema }),
  queryStringParameters: z.record(z.string(), z.string()).nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
});

/** Result of an invocation: the status only. */
export interface WsConnectResult {
  readonly statusCode: ConnectStatus | 400;
}

/** The Lambda handler of the `ws-connect` function. */
export type WsConnectHandler = (event: unknown, context: Context) => Promise<WsConnectResult>;

/** Everything the handler needs. */
export interface WsConnectDeps {
  readonly store: WsSessionStore;
  readonly clock: Clock;
  readonly allowedOrigins: readonly string[];
  readonly logger: HandlerLogger;
  readonly metrics: WsMetricsPort;
}

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/**
 * Reads the `Origin` header, whatever the case of its name.
 *
 * @param headers - The request headers, or null when the request has none.
 * @returns The origin, or undefined when the request does not send one.
 */
function originOf(headers: Record<string, string> | null | undefined): string | undefined {
  if (headers === null || headers === undefined) {
    return undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "origin") {
      return value;
    }
  }
  return undefined;
}

/**
 * Builds the handler over its ports.
 *
 * @param deps - The ports and the observers the handler writes to.
 * @returns The Lambda handler. It returns a status for every event it can read; an unreadable event is 400.
 */
export function createWsConnectHandler(deps: WsConnectDeps): WsConnectHandler {
  return async (event, context) => {
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: context.awsRequestId });
    try {
      const parsed = ConnectEventSchema.safeParse(event);
      if (!parsed.success) {
        deps.metrics.count("WsConnectRefused");
        deps.logger.warn("connect event unreadable");
        return { statusCode: 400 };
      }
      const { statusCode } = await redeemAndConnect(
        {
          token: parsed.data.queryStringParameters?.["token"],
          origin: originOf(parsed.data.headers),
          connectionId: parsed.data.requestContext.connectionId,
        },
        {
          store: deps.store,
          clock: deps.clock,
          allowedOrigins: deps.allowedOrigins,
          logger: deps.logger,
        },
      );
      if (statusCode === 200) {
        deps.metrics.count("WsConnected");
      } else if (statusCode === 500) {
        deps.metrics.count("WsConnectFailed");
      } else {
        deps.metrics.count("WsConnectRefused");
      }
      deps.logger.info("connect answered", { statusCode });
      return { statusCode };
    } catch (error) {
      deps.logger.error("connect failed", safeErrorFields(error));
      return { statusCode: 500 };
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
function buildProductionHandler(observability: Observability): WsConnectHandler {
  const env = loadWsConnectEnv(process.env);
  const store = new DynamoDbWsSession(
    createDynamoDocumentClient(env.AWS_REGION, observability.tracer),
    env.CONNECTIONS_TABLE_NAME,
  );
  return createWsConnectHandler({
    store,
    clock: { now: () => new Date() },
    allowedOrigins: env.WS_ALLOWED_ORIGINS,
    logger: handlerLogger(observability.logger),
    metrics: wsMetricsOf(observability.metrics),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: WsConnectHandler = buildProductionHandler(createObservability("ws-connect"));
