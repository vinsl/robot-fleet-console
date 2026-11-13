/**
 * Lambda entry point of the `alerts` function: the list of the active and the resolved alerts of a site, and the
 * acknowledgement and resolution of an alert, behind the JWT authorizer of API Gateway.
 *
 * The handler is thin. It takes the principal from the verified access token, routes the request, and refuses it
 * with a `403` before any store call when the caller's role is not allowed on the route or when the path names a
 * site the token does not grant. The actor of every action is the verified subject, never a value from the body or
 * the headers. The domain returns each outcome as a value; the handler maps it to RFC 7807, or to a response the
 * protocol schema accepts.
 *
 * Module scope builds the logger, the metrics, the tracer and the SDK clients, and reads the environment. A missing or
 * malformed variable throws at cold start, so the function never serves a request with a wrong configuration. The
 * remaining time of each invocation comes from the runtime context, so the relay of a change is skipped when the
 * function is about to time out.
 */
import { MetricUnit, type Metrics } from "@aws-lambda-powertools/metrics";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import {
  AlertActionRequestSchema,
  AlertActionResponseSchema,
  AlertListQuerySchema,
  AlertListResponseSchema,
  uuidv7,
  type AlertAction,
  type CorrelationId,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from "aws-lambda";
import { z } from "zod";
import { loadAlertsEnv } from "../config/env";
import { createDynamoDocumentClient, createManagementClient } from "../adapters/clients";
import { ApiGatewayPush } from "../adapters/apigw-push";
import { DynamoDbAlertStore } from "../adapters/dynamodb-alert-store";
import { DynamoDbAudit } from "../adapters/dynamodb-audit";
import { DynamoDbConnections } from "../adapters/dynamodb-connections";
import {
  getCorrelationId,
  issuesOf,
  JwtAuthorizerSchema,
  jsonResponse,
  parseBody,
  problemResponse,
  type HttpResult,
} from "../adapters/http";
import { principalFromClaims, type Principal } from "../domain/authz";
import { actOnAlert } from "../domain/alerts/act-on-alert";
import { listAlerts } from "../domain/alerts/list-alerts";
import { createAlertRelay } from "../domain/alerts/relay";
import { parseAlertRoute, rolesOf, type AlertRoute } from "../domain/alerts/route";
import type { AlertCall, AlertsDeps, AlertsMetricName } from "../domain/alerts/ports";
import type { Clock, Deadline } from "../domain/ports";
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

/**
 * Remaining time assumed when the runtime passes no context: local runs and tests. Production always passes the
 * context, and the Lambda timeout is 5 seconds, so the value only matters where there is no runtime at all.
 */
const FALLBACK_REMAINING_MS = 5000;

/** Fixed sentences of the refusals this handler writes. None is built from input. */
const DETAIL = {
  noConsoleRole: "The token does not grant a console role.",
  roleNotAllowed: "The role does not allow this request.",
  siteNotAllowed: "The principal has no access to this site.",
  invalidPath: "The request does not match the schema.",
  invalidQuery: "The query string does not match the schema.",
} as const;

/** The part of the runtime context the handler reads: the time left before the function is stopped. */
export type AlertsContext = Pick<Context, "getRemainingTimeInMillis">;

/** Metrics of the handler: the business counters of the alerts use cases, published once per invocation. */
export interface AlertsHandlerMetrics {
  /** Adds one to the named counter. */
  count(name: AlertsMetricName): void;
  /** Publishes the counters of the invocation. */
  publishStoredMetrics(): void;
}

/** Tracer of the handler: annotations only, the clients are wrapped at module scope. */
export interface AlertsHandlerTracer {
  /** Adds an annotation to the current segment, searchable in X-Ray. */
  putAnnotation(key: string, value: string): void;
}

/** Everything the handler needs. Production passes the Powertools utilities and the AWS adapters. */
export interface AlertsHandlerDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
  /** Metrics. */
  readonly metrics: AlertsHandlerMetrics;
  /** Tracer. */
  readonly tracer: AlertsHandlerTracer;
  /** Ports of the domain. The logger, the metrics and the deadline are added per invocation by the handler. */
  readonly ports: Omit<AlertsDeps, "logger" | "metrics" | "deadline">;
}

/** The Lambda handler of the `alerts` function. */
export type AlertsHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context?: AlertsContext,
) => Promise<HttpResult>;

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
 * Builds the deadline of one invocation from the runtime context. It is read lazily, when the domain asks, so the
 * time left is the time left at that moment.
 *
 * @param context - The runtime context, when the runtime passes one.
 * @returns The deadline of the invocation.
 */
function deadlineOf(context: AlertsContext | undefined): Deadline {
  return {
    remainingMs: () => context?.getRemainingTimeInMillis() ?? FALLBACK_REMAINING_MS,
  };
}

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - Logger, metrics, tracer and the domain ports.
 * @returns The Lambda handler. Every outcome is returned, never thrown: a refusal is a `4xx` problem, a bug is a
 * `500` with no internal text.
 */
export function createAlertsHandler(deps: AlertsHandlerDeps): AlertsHandler {
  const { logger, metrics, tracer, ports } = deps;

  /**
   * Builds the success or the problem response of a use case, and checks the value against the protocol schema
   * before it is serialised. A value the schema refuses is an internal failure, logged by its paths only.
   *
   * @param route - The name of the route, for the log.
   * @param correlationId - The correlation identifier of the invocation.
   * @param result - The outcome of the use case.
   * @param schema - The response schema of the route.
   * @returns The proxy result.
   */
  function respond<T>(
    route: AlertRoute["name"],
    correlationId: CorrelationId,
    result: UseCaseResult<T>,
    schema: z.ZodType<T>,
  ): HttpResult {
    if (!result.ok) {
      if (result.issues !== undefined) {
        logger.warn("alerts request refused", { route, issues: issuesOf(result.issues) });
      }
      return problemResponse(
        result.problem.type,
        result.problem.status,
        correlationId,
        result.problem.detail,
      );
    }
    const checked = schema.safeParse(result.value);
    if (!checked.success) {
      logger.error("result refused by schema", {
        route,
        issues: issuesOf(checked.error.issues),
      });
      return problemResponse("internal", 500, correlationId);
    }
    return jsonResponse(200, checked.data, correlationId);
  }

  /**
   * Runs the use case of an authorised route. The query string and the body are read here, after the checks, so a
   * refused caller never has its parameters parsed.
   *
   * @param event - The proxy event, for the query string and the body.
   * @param route - The authorised route, with its validated parameters.
   * @param call - The verified caller and the correlation identifier.
   * @param domain - The domain dependencies of this invocation.
   * @returns The proxy result.
   */
  async function dispatch(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
    route: AlertRoute,
    call: AlertCall,
    domain: AlertsDeps,
  ): Promise<HttpResult> {
    const correlationId = call.correlationId;
    switch (route.name) {
      case "listAlerts": {
        const query = AlertListQuerySchema.safeParse(event.queryStringParameters ?? {});
        if (!query.success) {
          logger.warn("alerts request refused", {
            route: route.name,
            issues: issuesOf(query.error.issues),
          });
          return problemResponse("invalid-request", 400, correlationId, DETAIL.invalidQuery);
        }
        return respond(
          route.name,
          correlationId,
          await listAlerts(domain, route.siteId, query.data),
          AlertListResponseSchema,
        );
      }
      case "acknowledgeAlert":
      case "resolveAlert": {
        const body = parseBody(event, AlertActionRequestSchema);
        if (!body.ok) {
          return body.response;
        }
        const action: AlertAction = route.name === "acknowledgeAlert" ? "acknowledge" : "resolve";
        return respond(
          route.name,
          correlationId,
          await actOnAlert(domain, call, action, route.siteId, route.alertId, body.data),
          AlertActionResponseSchema,
        );
      }
    }
  }

  return async (event, context) => {
    const correlationId = getCorrelationId(event);
    logger.appendKeys({ correlationId });
    try {
      const principal = principalOf(event);
      if (principal === null) {
        logger.warn("alerts request refused", { reason: "no-console-role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.noConsoleRole);
      }

      // The route and the path are checked before the role and the site: the JWT authorizer has already required
      // a valid token, and an unknown route or a malformed path reveals nothing about any site.
      const parsed = parseAlertRoute(event.routeKey, event.pathParameters);
      if (!parsed.ok) {
        return parsed.reason === "unknown-route"
          ? problemResponse("not-found", 404, correlationId)
          : problemResponse("invalid-request", 400, correlationId, DETAIL.invalidPath);
      }
      const route = parsed.route;
      logger.appendKeys({ route: route.name });
      tracer.putAnnotation("route", route.name);

      // Every check below runs before the first store call of the request.
      if (!rolesOf(route.name).includes(principal.role)) {
        logger.warn("alerts request refused", { reason: "role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.roleNotAllowed);
      }
      if (route.siteId !== principal.siteId) {
        logger.warn("alerts request refused", { reason: "site" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.siteNotAllowed);
      }

      const call: AlertCall = { actor: principal.userId, correlationId };
      const domain: AlertsDeps = {
        ...ports,
        logger,
        metrics,
        deadline: deadlineOf(context),
      };
      return await dispatch(event, route, call, domain);
    } catch (error) {
      // The message of an unexpected error can carry an ARN or a request fragment: only its name is logged.
      logger.error("alerts request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      metrics.publishStoredMetrics();
      // The keys belong to this invocation: a warm container must not carry them into the next one.
      logger.removeKeys(INVOCATION_LOG_KEYS);
    }
  };
}

/**
 * Adapts the Powertools metrics to the alerts counters. Each occurrence is added as one count; the handler publishes
 * the stored metrics once per invocation.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The alerts counters.
 */
function powertoolsAlertsMetrics(metrics: Metrics): AlertsHandlerMetrics {
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
function annotationsOf(tracer: Tracer): AlertsHandlerTracer {
  return {
    putAnnotation: (key, value) => {
      tracer.putAnnotation(key, value);
    },
  };
}

/**
 * Wires the production handler: the environment, the observability, the SDK clients and the adapters. Runs once per
 * cold start, and makes no call.
 *
 * @param observability - The Powertools utilities of the function.
 * @returns The Lambda handler.
 */
function buildProductionHandler(observability: Observability): AlertsHandler {
  const env = loadAlertsEnv(process.env);
  const logger = handlerLogger(observability.logger);
  const metrics = powertoolsAlertsMetrics(observability.metrics);
  const clock: Clock = { now: () => new Date() };
  const dynamo = createDynamoDocumentClient(env.AWS_REGION, observability.tracer);
  const management = observability.tracer.captureAWSv3Client(
    createManagementClient(env.WS_MANAGEMENT_ENDPOINT, env.AWS_REGION),
  );

  return createAlertsHandler({
    logger,
    metrics,
    tracer: annotationsOf(observability.tracer),
    ports: {
      store: new DynamoDbAlertStore(
        dynamo,
        { fleetTable: env.FLEET_TABLE_NAME, eventsTable: env.EVENTS_TABLE_NAME },
        () => {
          metrics.count("AlertMarkerMismatch");
        },
        () => {
          metrics.count("AlertCursorRejected");
        },
      ),
      audit: new DynamoDbAudit(dynamo, env.EVENTS_TABLE_NAME),
      relay: createAlertRelay({
        connections: new DynamoDbConnections(dynamo, env.CONNECTIONS_TABLE_NAME),
        push: new ApiGatewayPush(management, logger),
        clock,
        logger,
        metrics,
      }),
      clock,
      ids: { uuidv7: () => uuidv7() },
    },
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: AlertsHandler = buildProductionHandler(createObservability("alerts"));
