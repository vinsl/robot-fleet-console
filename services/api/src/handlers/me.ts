/**
 * Lambda entry point of the `me` function: returns the identity of the caller for `GET /me`.
 *
 * The function sits behind the JWT authorizer of API Gateway, which has verified the access token. The handler
 * reads the verified claims, decides the role, and answers. It makes no AWS call and reads no header or body, so
 * the only input it trusts is the claim set the authorizer produced.
 *
 * The handler is thin and returns every outcome: a token without a console role is a `403`, and an unexpected
 * failure is a `500` with no internal text. Module scope only builds the logger; nothing is fetched.
 */
import { MeSchema, type CorrelationId, type Me } from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  getCorrelationId,
  JwtAuthorizerSchema,
  jsonResponse,
  problemResponse,
  type HttpResult,
} from "../adapters/http";
import { principalFromClaims } from "../domain/authz";
import { safeErrorFields } from "../domain/safe-error";
import { createObservability, handlerLogger, type HandlerLogger } from "../observability";

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/** Everything the handler needs. Production passes the Powertools logger. */
export interface MeHandlerDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
}

/** The Lambda handler of the `me` function. */
export type MeHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => HttpResult;

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - The logger of the handler.
 * @returns The Lambda handler.
 */
export function createMeHandler(deps: MeHandlerDeps): MeHandler {
  return (event) => {
    const correlationId: CorrelationId = getCorrelationId(event);
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: correlationId });
    try {
      const authorizer = JwtAuthorizerSchema.safeParse(event.requestContext.authorizer);
      const principal = authorizer.success ? principalFromClaims(authorizer.data.jwt.claims) : null;
      if (principal === null) {
        deps.logger.warn("identity refused", { reason: "no-console-role" });
        return problemResponse(
          "forbidden",
          403,
          correlationId,
          "The token does not grant a console role.",
        );
      }
      const me: Me = MeSchema.parse({
        userId: principal.userId,
        role: principal.role,
        siteId: principal.siteId,
      });
      return jsonResponse(200, me, correlationId);
    } catch (error) {
      deps.logger.error("identity request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      deps.logger.removeKeys([INVOCATION_LOG_KEY]);
    }
  };
}

/** The Lambda handler, built once per cold start. Only the logger is wired: the function needs no other resource. */
export const handler: MeHandler = createMeHandler({
  logger: handlerLogger(createObservability("me").logger),
});
