/**
 * Lambda entry point of the `ws-token` function: issues a single-use WebSocket token, invoked with IAM.
 *
 * The handler is thin. It validates the event, dispatches to the domain, and maps the outcome to a status and a
 * problem. Module scope holds the one-time wiring: the environment is parsed (failing closed), and the SDK
 * client is built, none of them making a call.
 *
 * The principal comes from the invoke event in M5 and is replaced by the verified JWT claims in M6; only this
 * file's event parsing changes then. The token is never logged, and the handler is not wrapped with
 * `captureLambdaHandler`, so no response is copied into a trace.
 */
import { randomBytes } from "node:crypto";
import {
  CorrelationIdSchema,
  PrincipalSchema,
  WsTokenRequestSchema,
  type CorrelationId,
  type Problem,
  type WsTokenResponse,
} from "@mfc/protocol";
import type { Context } from "aws-lambda";
import { z } from "zod";
import { DynamoDbWsSession } from "../adapters/dynamodb-ws-session";
import { createDynamoDocumentClient } from "../adapters/clients";
import { loadWsTokenEnv } from "../config/env";
import { safeErrorFields } from "../domain/safe-error";
import type { Clock } from "../domain/ports";
import type { WsMetricsPort } from "../domain/ws/metrics";
import { WS_PROBLEMS, wsProblem } from "../domain/ws/problems";
import { WsDenied, issueToken, type WsSessionStore } from "../domain/ws/token";
import {
  createObservability,
  handlerLogger,
  wsMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";

/**
 * Event of an invocation, built by the operator's script (M5) or by the verified-claims adapter (M6). Strict:
 * an extra key means the caller and the function disagree.
 */
export const WsTokenInvokeEventSchema = z.strictObject({
  principal: PrincipalSchema,
  request: WsTokenRequestSchema,
  correlationId: CorrelationIdSchema,
});

/** Result of an invocation: the token response, or a problem with its status. */
export type WsTokenResult =
  | { readonly statusCode: 200; readonly body: WsTokenResponse }
  | { readonly statusCode: 400 | 403 | 500; readonly body: Problem };

/** The Lambda handler of the `ws-token` function. */
export type WsTokenHandler = (event: unknown, context: Context) => Promise<WsTokenResult>;

/** Everything the handler needs. Production passes the AWS adapter and the Powertools utilities. */
export interface WsTokenDeps {
  readonly store: WsSessionStore;
  readonly clock: Clock;
  readonly random: (size: number) => Buffer;
  readonly url: string;
  readonly logger: HandlerLogger;
  readonly metrics: WsMetricsPort;
}

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/**
 * Builds the handler over its ports.
 *
 * @param deps - The ports and the observers the handler writes to.
 * @returns The Lambda handler.
 */
export function createWsTokenHandler(deps: WsTokenDeps): WsTokenHandler {
  return async (event, context) => {
    const parsed = WsTokenInvokeEventSchema.safeParse(event);
    // A refused event has no trustworthy correlation identifier: the request id of the invocation stands in.
    const correlationId: CorrelationId = parsed.success
      ? parsed.data.correlationId
      : context.awsRequestId;
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: correlationId });
    try {
      if (!parsed.success) {
        deps.metrics.count("WsTokenRefused");
        deps.logger.warn("token request refused", { reason: "invalid-request" });
        return { statusCode: 400, body: wsProblem(WS_PROBLEMS.invalidRequest, correlationId) };
      }
      const response = await issueToken(parsed.data.principal, parsed.data.request, deps);
      deps.metrics.count("WsTokenIssued");
      deps.logger.info("token issued");
      return { statusCode: 200, body: response };
    } catch (error) {
      if (error instanceof WsDenied) {
        deps.metrics.count("WsTokenRefused");
        deps.logger.warn("token request refused", { reason: error.code });
        return error.code === "FORBIDDEN_SITE"
          ? { statusCode: 403, body: wsProblem(WS_PROBLEMS.forbiddenSite, correlationId) }
          : { statusCode: 400, body: wsProblem(WS_PROBLEMS.invalidSession, correlationId) };
      }
      deps.metrics.count("WsTokenFailed");
      deps.logger.error("token request failed", safeErrorFields(error));
      return { statusCode: 500, body: wsProblem(WS_PROBLEMS.internal, correlationId) };
    } finally {
      deps.metrics.publishStoredMetrics();
      deps.logger.removeKeys([INVOCATION_LOG_KEY]);
    }
  };
}

/**
 * Wires the production handler. Runs once per cold start: a missing or malformed environment variable throws
 * here, so the function never issues a token with a wrong configuration.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): WsTokenHandler {
  const env = loadWsTokenEnv(process.env);
  const clock: Clock = { now: () => new Date() };
  const store = new DynamoDbWsSession(
    createDynamoDocumentClient(env.AWS_REGION, observability.tracer),
    env.CONNECTIONS_TABLE_NAME,
  );
  return createWsTokenHandler({
    store,
    clock,
    random: randomBytes,
    url: env.WS_URL,
    logger: handlerLogger(observability.logger),
    metrics: wsMetricsOf(observability.metrics),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: WsTokenHandler = buildProductionHandler(createObservability("ws-token"));
