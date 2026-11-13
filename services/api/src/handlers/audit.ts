/**
 * Lambda entry point of the `audit` function: the read of the audit trail of a site, one page per request, behind the
 * JWT authorizer of API Gateway.
 *
 * The handler is thin. It takes the principal from the verified access token, routes the request, and refuses it with a
 * `403` before any store call when the token does not grant a console role or names another site. The domain returns
 * each outcome as a value; the handler maps it to RFC 7807, or to a response the protocol schema accepts. The function
 * has no write permission: it reads the status index of the events table, and nothing else.
 *
 * Module scope reads the environment and builds the SDK client. A missing or malformed variable throws at cold start,
 * so the function never serves a request with a wrong configuration.
 */
import {
  AuditListQuerySchema,
  AuditListResponseSchema,
  type AuditListResponse,
  type CorrelationId,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { loadAuditEnv } from "../config/admin-env";
import { createDynamoDocumentClient } from "../adapters/clients";
import { DynamoDbAuditReader } from "../adapters/dynamodb-audit";
import {
  getCorrelationId,
  issuesOf,
  JwtAuthorizerSchema,
  jsonResponse,
  problemResponse,
  type HttpResult,
} from "../adapters/http";
import { principalFromClaims, type Principal } from "../domain/authz";
import { listAudit, type AuditListDeps } from "../domain/audit/list-audit";
import { parseAuditRoute } from "../domain/audit/route";
import type { AuditReaderPort } from "../domain/audit/ports";
import type { UseCaseResult } from "../domain/result";
import { safeErrorFields } from "../domain/safe-error";
import {
  createObservability,
  handlerLogger,
  type HandlerLogger,
  type Observability,
} from "../observability";

/** Keys this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEYS = ["correlationId", "route"];

/** Route name written to the log of the invocation. */
const ROUTE_NAME = "listAudit";

/** Fixed sentences of the refusals this handler writes. None is built from input. */
const DETAIL = {
  noConsoleRole: "The token does not grant a console role.",
  siteNotAllowed: "The principal has no access to this site.",
  invalidPath: "The request does not match the schema.",
  invalidQuery: "The query string does not match the schema.",
} as const;

/** Everything the handler needs. Production passes the AWS adapter, tests a fake. */
export interface AuditHandlerDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
  /** Reader of the trail. */
  readonly reader: AuditReaderPort;
}

/** The Lambda handler of the `audit` function. */
export type AuditHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<HttpResult>;

/**
 * Reads the principal of a request from the verified claims of its authorizer.
 *
 * @param event - The proxy event.
 * @returns The principal, or `null` when the request carries no access token with a console role.
 */
function principalOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Principal | null {
  const authorizer = JwtAuthorizerSchema.safeParse(event.requestContext.authorizer);
  return authorizer.success ? principalFromClaims(authorizer.data.jwt.claims) : null;
}

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - The logger and the reader.
 * @returns The Lambda handler. Every outcome is returned, never thrown: a refusal is a `4xx` problem, a bug is a `500`
 * with no internal text.
 */
export function createAuditHandler(deps: AuditHandlerDeps): AuditHandler {
  const { logger, reader } = deps;

  /**
   * Builds the success or the problem response of the use case, and checks the value against the protocol schema
   * before it is serialised. A value the schema refuses is an internal failure, logged by its paths only.
   *
   * @param correlationId - The correlation identifier of the invocation.
   * @param result - The outcome of the use case.
   * @returns The proxy result.
   */
  function respond(
    correlationId: CorrelationId,
    result: UseCaseResult<AuditListResponse>,
  ): HttpResult {
    if (!result.ok) {
      if (result.issues !== undefined) {
        logger.warn("audit request refused", {
          route: ROUTE_NAME,
          issues: issuesOf(result.issues),
        });
      }
      return problemResponse(
        result.problem.type,
        result.problem.status,
        correlationId,
        result.problem.detail,
      );
    }
    const checked = AuditListResponseSchema.safeParse(result.value);
    if (!checked.success) {
      logger.error("result refused by schema", {
        route: ROUTE_NAME,
        issues: issuesOf(checked.error.issues),
      });
      return problemResponse("internal", 500, correlationId);
    }
    return jsonResponse(200, checked.data, correlationId);
  }

  return async (event) => {
    const correlationId = getCorrelationId(event);
    logger.appendKeys({ correlationId });
    try {
      const principal = principalOf(event);
      if (principal === null) {
        logger.warn("audit request refused", { reason: "no-console-role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.noConsoleRole);
      }

      // The route and the path are checked before the site: the JWT authorizer has already required a valid token,
      // and an unknown route or a malformed path reveals nothing about any site.
      const parsed = parseAuditRoute(event.routeKey, event.pathParameters);
      if (!parsed.ok) {
        return parsed.reason === "unknown-route"
          ? problemResponse("not-found", 404, correlationId)
          : problemResponse("invalid-request", 400, correlationId, DETAIL.invalidPath);
      }
      logger.appendKeys({ route: ROUTE_NAME });

      // The site check runs before the first read of the request.
      if (parsed.siteId !== principal.siteId) {
        logger.warn("audit request refused", { reason: "site" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.siteNotAllowed);
      }

      // The query is read after the checks, so a refused caller never has its parameters parsed. The schema is strict:
      // a filter the API does not offer is refused, not ignored.
      const query = AuditListQuerySchema.safeParse(event.queryStringParameters ?? {});
      if (!query.success) {
        logger.warn("audit request refused", {
          route: ROUTE_NAME,
          issues: issuesOf(query.error.issues),
        });
        return problemResponse("invalid-request", 400, correlationId, DETAIL.invalidQuery);
      }

      const deps: AuditListDeps = { reader, logger };
      return respond(correlationId, await listAudit(deps, parsed.siteId, query.data));
    } catch (error) {
      // The message of an unexpected error can carry an ARN or a request fragment: only its name is logged.
      logger.error("audit request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      // The keys belong to this invocation: a warm container must not carry them into the next one.
      logger.removeKeys(INVOCATION_LOG_KEYS);
    }
  };
}

/**
 * Wires the production handler: the environment, the observability and the SDK client. Runs once per cold start, and
 * makes no call.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): AuditHandler {
  const env = loadAuditEnv(process.env);
  const dynamo = createDynamoDocumentClient(env.AWS_REGION, observability.tracer);
  return createAuditHandler({
    logger: handlerLogger(observability.logger),
    reader: new DynamoDbAuditReader(dynamo, env.EVENTS_TABLE_NAME),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: AuditHandler = buildProductionHandler(createObservability("audit"));
