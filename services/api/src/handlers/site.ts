/**
 * Lambda entry point of the `site` function: the site profile, its map versions and the presigned transfers of the
 * map files, behind the JWT authorizer of API Gateway.
 *
 * The handler is thin. It takes the principal from the verified claims, routes the request, and refuses it with a
 * `403` before any store or object call when the caller's role is not allowed on the route, when the path names a
 * site the token does not grant, or when a Viewer or an Operator asks for a map version other than the active one.
 * The actor of every write is the verified subject, never a value from the body or the headers. The domain returns
 * each outcome as a value; the handler maps it to RFC 7807, or to a response the protocol schema accepts.
 *
 * Module scope builds the logger, the metrics, the tracer and the SDK clients, and reads the environment. A missing or
 * malformed variable throws at cold start, so the function never serves a request with a wrong configuration. Neither
 * a presigned URL nor the body of a map file reaches a log.
 */
import { MetricUnit, type Metrics } from "@aws-lambda-powertools/metrics";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import {
  CreateMapResponseSchema,
  MapUrlResponseSchema,
  MapVersionSchema,
  MapVersionsResponseSchema,
  SiteSchema,
  UpdateSiteRequestSchema,
  uuidv7,
  type CorrelationId,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { z } from "zod";
import { createDynamoDocumentClient, createS3Client } from "../adapters/clients";
import { DynamoDbAudit } from "../adapters/dynamodb-audit";
import { DynamoDbSiteStore } from "../adapters/dynamodb-site";
import {
  getCorrelationId,
  issuesOf,
  JwtAuthorizerSchema,
  jsonResponse,
  parseBody,
  problemResponse,
  type HttpResult,
} from "../adapters/http";
import { S3MapObjectStore } from "../adapters/s3-site-maps";
import { principalFromClaims, type Principal } from "../domain/authz";
import type { Clock } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import { loadSiteEnv } from "../config/env";
import { activateMap } from "../domain/site/activate-map";
import { getMapUrl } from "../domain/site/get-map-url";
import { getSite } from "../domain/site/get-site";
import { listMaps } from "../domain/site/list-maps";
import { createMap } from "../domain/site/create-map";
import { parseSiteRoute, rolesOf, type SiteRoute } from "../domain/site/route";
import type { SiteCall, SiteDeps, SiteMetricName } from "../domain/site/ports";
import type { SiteResult } from "../domain/site/result";
import { updateSite } from "../domain/site/update-site";
import { validateMap } from "../domain/site/validate-map";
import {
  createObservability,
  handlerLogger,
  type HandlerLogger,
  type Observability,
} from "../observability";

/** Keys this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEYS = ["correlationId", "route"];

/** Fixed sentences of the refusals this handler writes. None is built from input. */
const DETAIL = {
  noConsoleRole: "The token does not grant a console role.",
  roleNotAllowed: "The role does not allow this request.",
  siteNotAllowed: "The principal has no access to this site.",
  activeMapOnly: "This role may only read the active map.",
  invalidPath: "The request does not match the schema.",
} as const;

/** Metrics of the handler: the business counters of the site use cases, published once per invocation. */
export interface SiteHandlerMetrics {
  /** Adds one to the named counter. */
  count(name: SiteMetricName): void;
  /** Publishes the counters of the invocation. */
  publishStoredMetrics(): void;
}

/** Tracer of the handler: annotations only, the clients are wrapped at module scope. */
export interface SiteHandlerTracer {
  /** Adds an annotation to the current segment, searchable in X-Ray. */
  putAnnotation(key: string, value: string): void;
}

/** Everything the handler needs. Production passes the Powertools utilities and the AWS adapters. */
export interface SiteHandlerDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
  /** Metrics. */
  readonly metrics: SiteHandlerMetrics;
  /** Tracer. */
  readonly tracer: SiteHandlerTracer;
  /** Ports of the domain. The logger and the metrics are added by the handler. */
  readonly ports: Omit<SiteDeps, "logger" | "metrics">;
}

/** The Lambda handler of the `site` function. */
export type SiteHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<HttpResult>;

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
 * @param deps - Logger, metrics, tracer and the domain ports.
 * @returns The Lambda handler. Every outcome is returned, never thrown: a refusal is a `4xx` problem, a bug is a
 * `500` with no internal text.
 */
export function createSiteHandler(deps: SiteHandlerDeps): SiteHandler {
  const { logger, metrics, tracer, ports } = deps;
  const domain: SiteDeps = { ...ports, logger, metrics };

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
    route: SiteRoute["name"],
    correlationId: CorrelationId,
    result: SiteResult<T>,
    schema: z.ZodType<T>,
  ): HttpResult {
    if (!result.ok) {
      if (result.issues !== undefined) {
        logger.warn("site request refused", { route, issues: issuesOf(result.issues) });
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
      logger.error("result refused by schema", { route, issues: issuesOf(checked.error.issues) });
      return problemResponse("internal", 500, correlationId);
    }
    return jsonResponse(200, checked.data, correlationId);
  }

  /**
   * Runs the use case of an authorised route. The body of `PUT /sites/{siteId}` is read here, after the checks, so a
   * refused caller never has its body parsed.
   *
   * @param event - The proxy event, for the body of the update.
   * @param route - The authorised route, with its validated parameters.
   * @param call - The verified caller and the correlation identifier.
   * @returns The proxy result.
   */
  async function dispatch(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
    route: SiteRoute,
    call: SiteCall,
  ): Promise<HttpResult> {
    const correlationId = call.correlationId;
    switch (route.name) {
      case "getSite":
        return respond(route.name, correlationId, await getSite(domain, route.siteId), SiteSchema);
      case "updateSite": {
        const body = parseBody(event, UpdateSiteRequestSchema);
        if (!body.ok) {
          return body.response;
        }
        return respond(
          route.name,
          correlationId,
          await updateSite(domain, call, route.siteId, body.data),
          SiteSchema,
        );
      }
      case "listMaps":
        return respond(
          route.name,
          correlationId,
          await listMaps(domain, route.siteId),
          MapVersionsResponseSchema,
        );
      case "createMap":
        return respond(
          route.name,
          correlationId,
          await createMap(domain, call, route.siteId),
          CreateMapResponseSchema,
        );
      case "getMapUrl":
        return respond(
          route.name,
          correlationId,
          await getMapUrl(domain, route.siteId, route.ref),
          MapUrlResponseSchema,
        );
      case "validateMap":
        return respond(
          route.name,
          correlationId,
          await validateMap(domain, call, route.siteId, route.version),
          MapVersionSchema,
        );
      case "activateMap":
        return respond(
          route.name,
          correlationId,
          await activateMap(domain, call, route.siteId, route.version),
          SiteSchema,
        );
    }
  }

  return async (event) => {
    const correlationId = getCorrelationId(event);
    logger.appendKeys({ correlationId });
    try {
      const principal = principalOf(event);
      if (principal === null) {
        logger.warn("site request refused", { reason: "no-console-role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.noConsoleRole);
      }

      // The route and the path are checked before the role and the site: the JWT authorizer has already required
      // a valid token, and an unknown route or a malformed path reveals nothing about any site.
      const parsed = parseSiteRoute(event.routeKey, event.pathParameters);
      if (!parsed.ok) {
        return parsed.reason === "unknown-route"
          ? problemResponse("not-found", 404, correlationId)
          : problemResponse("invalid-request", 400, correlationId, DETAIL.invalidPath);
      }
      const route = parsed.route;
      logger.appendKeys({ route: route.name });
      tracer.putAnnotation("route", route.name);

      // Every check below runs before the first store or object call of the request.
      if (!rolesOf(route.name).includes(principal.role)) {
        logger.warn("site request refused", { reason: "role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.roleNotAllowed);
      }
      if (route.siteId !== principal.siteId) {
        logger.warn("site request refused", { reason: "site" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.siteNotAllowed);
      }
      if (route.name === "getMapUrl" && route.ref !== "active" && principal.role !== "Admin") {
        logger.warn("site request refused", { reason: "map-ref" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.activeMapOnly);
      }

      const call: SiteCall = { actor: principal.userId, correlationId };
      return await dispatch(event, route, call);
    } catch (error) {
      // The message of an unexpected error can carry an ARN or a request fragment: only its name is logged.
      logger.error("site request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      metrics.publishStoredMetrics();
      // The keys belong to this invocation: a warm container must not carry them into the next one.
      logger.removeKeys(INVOCATION_LOG_KEYS);
    }
  };
}

/**
 * Adapts the Powertools metrics to the site counters. Each occurrence is added as one count; the handler publishes
 * the stored metrics once per invocation.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The site counters.
 */
function powertoolsSiteMetrics(metrics: Metrics): SiteHandlerMetrics {
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
function annotationsOf(tracer: Tracer): SiteHandlerTracer {
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
function buildProductionHandler(observability: Observability): SiteHandler {
  const env = loadSiteEnv(process.env);
  const dynamo = createDynamoDocumentClient(env.region, observability.tracer);
  const s3 = createS3Client(env.region, observability.tracer);
  const clock: Clock = { now: () => new Date() };

  return createSiteHandler({
    logger: handlerLogger(observability.logger),
    metrics: powertoolsSiteMetrics(observability.metrics),
    tracer: annotationsOf(observability.tracer),
    ports: {
      store: new DynamoDbSiteStore(dynamo, env.fleetTable),
      objects: new S3MapObjectStore(s3, env.bucket, clock),
      audit: new DynamoDbAudit(dynamo, env.eventsTable),
      clock,
      ids: { uuidv7: () => uuidv7() },
    },
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: SiteHandler = buildProductionHandler(createObservability("site"));
