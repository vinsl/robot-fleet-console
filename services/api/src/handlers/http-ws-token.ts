/**
 * Lambda entry point of the `http-ws-token` function: `POST /ws-token`, issuing a single-use WebSocket token to
 * the caller.
 *
 * The function sits behind the JWT authorizer, which has verified the access token. The handler builds the
 * principal from the verified claims, validates the body, and calls the same domain function the IAM-invoked
 * `ws-token` function uses (`issueToken`). The token is never logged, and the handler is not wrapped with a tracer
 * that copies responses.
 */
import { randomBytes } from "node:crypto";
import {
  PrincipalSchema,
  WsTokenRequestSchema,
  type Principal,
  type WsTokenResponse,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { DynamoDbWsSession } from "../adapters/dynamodb-ws-session";
import { createDynamoDocumentClient } from "../adapters/clients";
import {
  getCorrelationId,
  JwtAuthorizerSchema,
  jsonResponse,
  parseBody,
  problemResponse,
  type HttpResult,
} from "../adapters/http";
import { principalFromClaims, sessionExpiresAtOf } from "../domain/authz";
import type { Clock } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import { issueToken, WsDenied, type IssueDeps } from "../domain/ws/token";
import { loadWsTokenEnv } from "../config/env";
import {
  createObservability,
  handlerLogger,
  type HandlerLogger,
  type Observability,
} from "../observability";

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/** Everything the handler needs. Production passes the DynamoDB store, the clock, the URL and the logger. */
export interface HttpWsTokenDeps extends IssueDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
  /** Clock of the instant the session window is checked against. */
  readonly clock: Clock;
}

/** The Lambda handler of the `http-ws-token` function. */
export type HttpWsTokenHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => Promise<HttpResult>;

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - The store, clock, random source, URL and logger.
 * @returns The Lambda handler. Every outcome is returned: a refusal is a 4xx problem and a failure is a 500.
 */
export function createHttpWsTokenHandler(deps: HttpWsTokenDeps): HttpWsTokenHandler {
  return async (event) => {
    const correlationId = getCorrelationId(event);
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: correlationId });
    try {
      const claims = JwtAuthorizerSchema.safeParse(event.requestContext.authorizer);
      const principal = claims.success ? principalFromClaims(claims.data.jwt.claims) : null;
      const sessionExpiresAt = claims.success ? sessionExpiresAtOf(claims.data.jwt.claims) : null;
      if (principal === null || sessionExpiresAt === null) {
        deps.logger.warn("token request refused", { reason: "no-console-role" });
        return problemResponse(
          "forbidden",
          403,
          correlationId,
          "The token does not grant a console role.",
        );
      }
      const body = parseBody(event, WsTokenRequestSchema);
      if (!body.ok) {
        return body.response;
      }
      const wsPrincipal: Principal = PrincipalSchema.parse({
        sub: principal.userId,
        role: principal.role,
        siteIds: [principal.siteId],
        sessionExpiresAt,
      });
      const response: WsTokenResponse = await issueToken(wsPrincipal, body.data, deps);
      deps.logger.info("token issued");
      return jsonResponse(200, response, correlationId);
    } catch (error) {
      if (error instanceof WsDenied) {
        deps.logger.warn("token request refused", { reason: error.code });
        return error.code === "FORBIDDEN_SITE"
          ? problemResponse(
              "forbidden",
              403,
              correlationId,
              "The principal has no access to this site.",
            )
          : problemResponse(
              "invalid-request",
              400,
              correlationId,
              "The session window of the principal is not valid.",
            );
      }
      deps.logger.error("token request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      deps.logger.removeKeys([INVOCATION_LOG_KEY]);
    }
  };
}

/**
 * Wires the production handler. Runs once per cold start: a malformed environment throws here, so the function
 * never issues a token with a wrong configuration.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): HttpWsTokenHandler {
  const env = loadWsTokenEnv(process.env);
  const store = new DynamoDbWsSession(
    createDynamoDocumentClient(env.AWS_REGION, observability.tracer),
    env.CONNECTIONS_TABLE_NAME,
  );
  return createHttpWsTokenHandler({
    store,
    clock: { now: () => new Date() },
    random: (size) => randomBytes(size),
    url: env.WS_URL,
    logger: handlerLogger(observability.logger),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: HttpWsTokenHandler = buildProductionHandler(
  createObservability("http-ws-token"),
);
