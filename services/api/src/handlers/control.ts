/**
 * Lambda entry point of the `control` function: the robot list, the robot lock, the controlled commands and the demo
 * mode of a site, behind the JWT authorizer of API Gateway.
 *
 * The handler is thin. It takes the principal from the verified access token, routes the request, and refuses it with a
 * `403` before any store call when the caller's role is not allowed on the route or when the path names a site the
 * token does not grant. The actor of every action is the verified subject, never a value from the body or the headers.
 * The lock token is minted and kept in the cloud: no response carries it, and no log record names it (ADR 0062).
 *
 * Module scope reads the environment and builds the SDK clients; {@link createControlServices} is the one place that
 * wires the domain ports to their adapters. A missing or malformed variable throws at cold start.
 */
import { randomBytes } from "node:crypto";
import { MetricUnit, type Metrics } from "@aws-lambda-powertools/metrics";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import {
  CommandRequestSchema,
  CommandResponseSchema,
  DemoStateSchema,
  DemoUpdateRequestSchema,
  LockActionResponseSchema,
  LockRequestSchema,
  LockStateSchema,
  RobotListResponseSchema,
  uuidv7,
  type CorrelationId,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from "aws-lambda";
import type { z } from "zod";
import { loadControlEnv, type ControlEnv } from "../config/env";
import { createDynamoDocumentClient, createManagementClient } from "../adapters/clients";
import { ApiGatewayPush } from "../adapters/apigw-push";
import { DynamoDbAudit } from "../adapters/dynamodb-audit";
import { DynamoDbCommandClaims, DynamoDbDemoStore } from "../adapters/dynamodb-control-state";
import { DynamoDbConnections } from "../adapters/dynamodb-connections";
import { DynamoDbLockStore } from "../adapters/dynamodb-lock";
import { DynamoDbRegistry } from "../adapters/dynamodb-registry";
import { createIotDataClient, IotCommandPublisher } from "../adapters/iot-publisher";
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
import { recordRoleRefusal } from "../domain/control/audit";
import { COMMAND_POLICY } from "../domain/control/policy";
import { acquireLock, getLock, releaseLock } from "../domain/control/lock";
import { listRobots } from "../domain/control/list-robots";
import { getDemo, setDemo } from "../domain/control/demo";
import { sendCommand } from "../domain/control/send-command";
import { createControlRelay } from "../domain/control/relay";
import { parseControlRoute, rolesOf, type ControlRoute } from "../domain/control/route";
import type { ControlCall, ControlDeps, ControlMetricName } from "../domain/control/ports";
import type { Clock, Ids } from "../domain/ports";
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

/**
 * Largest body of a control request, in bytes. A command or a lock request is a few dozen bytes; a larger body is an
 * attack, so it is refused before it is parsed.
 */
export const CONTROL_BODY_MAX_BYTES = 2048;

/** Fixed sentences of the refusals this handler writes. None is built from input. */
const DETAIL = {
  noConsoleRole: "The token does not grant a console role.",
  roleNotAllowed: "The role does not allow this request.",
  siteNotAllowed: "The principal has no access to this site.",
  invalidPath: "The request does not match the schema.",
} as const;

/** The part of the runtime context the handler reads: the time left before the function is stopped. */
export type ControlContext = Pick<Context, "getRemainingTimeInMillis">;

/** Metrics of the handler: the business counters of the control use cases, published once per invocation. */
export interface ControlHandlerMetrics {
  /** Adds one to the named counter. */
  count(name: ControlMetricName): void;
  /** Publishes the counters of the invocation. */
  publishStoredMetrics(): void;
}

/** Tracer of the handler: annotations only, the clients are wrapped at module scope. */
export interface ControlHandlerTracer {
  /** Adds an annotation to the current segment, searchable in X-Ray. */
  putAnnotation(key: string, value: string): void;
}

/** Everything the handler needs. Production passes the Powertools utilities and the AWS adapters. */
export interface ControlHandlerDeps {
  /** Logger that carries the correlation identifier of the invocation. */
  readonly logger: HandlerLogger;
  /** Metrics. */
  readonly metrics: ControlHandlerMetrics;
  /** Tracer. */
  readonly tracer: ControlHandlerTracer;
  /** Ports of the domain. The logger and the metrics are added per invocation by the handler. */
  readonly ports: Omit<ControlDeps, "logger" | "metrics">;
}

/** The Lambda handler of the `control` function. */
export type ControlHandler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context?: ControlContext,
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
 * Builds the call of one invocation: its correlation identifier, and the time left read when the domain asks.
 *
 * @param correlationId - The correlation identifier of the request.
 * @param context - The runtime context, when the runtime passes one.
 * @returns The call.
 */
function callOf(correlationId: CorrelationId, context: ControlContext | undefined): ControlCall {
  return {
    correlationId,
    remainingMs: () => context?.getRemainingTimeInMillis() ?? FALLBACK_REMAINING_MS,
  };
}

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - Logger, metrics, tracer and the domain ports.
 * @returns The Lambda handler. Every outcome is returned, never thrown: a refusal is a `4xx` problem, a bug is a `500`
 * with no internal text.
 */
export function createControlHandler(deps: ControlHandlerDeps): ControlHandler {
  const { logger, metrics, tracer, ports } = deps;

  /**
   * Builds the success or the problem response of a use case, and checks the value against the protocol schema before
   * it is serialised. A value the schema refuses is an internal failure, logged by its paths only.
   *
   * @param route - The name of the route, for the log.
   * @param correlationId - The correlation identifier of the invocation.
   * @param result - The outcome of the use case.
   * @param schema - The response schema of the route.
   * @returns The proxy result.
   */
  function respond<T>(
    route: ControlRoute["name"],
    correlationId: CorrelationId,
    result: UseCaseResult<T>,
    schema: z.ZodType<T>,
  ): HttpResult {
    if (!result.ok) {
      if (result.issues !== undefined) {
        logger.warn("control request refused", { route, issues: issuesOf(result.issues) });
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
   * Audits a role refusal of a lock or a command route before any store call, so that the refusal is on the trail
   * (D13). A command body that does not parse names no command, so nothing is written for it: the body is read here
   * only to name the command, and its failure is not answered again.
   *
   * @param event - The proxy event, for the body of a command.
   * @param route - The refused route, with its validated parameters.
   * @param principal - The verified caller.
   * @param call - The verified caller's correlation identifier.
   * @param domain - The domain dependencies of this invocation.
   */
  async function auditRoleRefusal(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
    route: ControlRoute,
    principal: Principal,
    call: ControlCall,
    domain: ControlDeps,
  ): Promise<void> {
    const base = {
      siteId: route.siteId,
      actor: principal.userId,
      correlationId: call.correlationId,
    };
    switch (route.name) {
      case "acquireLock":
      case "releaseLock":
        await recordRoleRefusal(domain, {
          ...base,
          robotId: route.robotId,
          action: route.name === "acquireLock" ? "lock.acquire" : "lock.release",
        });
        return;
      case "sendCommand": {
        const body = parseBody(event, CommandRequestSchema, CONTROL_BODY_MAX_BYTES);
        if (body.ok) {
          await recordRoleRefusal(domain, {
            ...base,
            robotId: route.robotId,
            commandId: body.data.commandId,
            action: COMMAND_POLICY[body.data.type].auditAction,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Runs the use case of an authorised route. The body is read here, after the checks, so a refused caller never has
   * its body parsed.
   *
   * @param event - The proxy event, for the body.
   * @param route - The authorised route, with its validated parameters.
   * @param principal - The verified caller.
   * @param call - The verified caller's correlation identifier and time left.
   * @param domain - The domain dependencies of this invocation.
   * @returns The proxy result.
   */
  async function dispatch(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
    route: ControlRoute,
    principal: Principal,
    call: ControlCall,
    domain: ControlDeps,
  ): Promise<HttpResult> {
    const correlationId = call.correlationId;
    switch (route.name) {
      case "listRobots":
        return respond(
          route.name,
          correlationId,
          await listRobots(domain, route.siteId),
          RobotListResponseSchema,
        );
      case "getLock":
        return respond(
          route.name,
          correlationId,
          await getLock(domain, principal, route),
          LockStateSchema,
        );
      case "acquireLock":
      case "releaseLock": {
        const body = parseBody(event, LockRequestSchema, CONTROL_BODY_MAX_BYTES);
        if (!body.ok) {
          return body.response;
        }
        const result =
          route.name === "acquireLock"
            ? await acquireLock(domain, principal, route, body.data, call)
            : await releaseLock(domain, principal, route, body.data, call);
        return respond(route.name, correlationId, result, LockActionResponseSchema);
      }
      case "sendCommand": {
        const body = parseBody(event, CommandRequestSchema, CONTROL_BODY_MAX_BYTES);
        if (!body.ok) {
          return body.response;
        }
        return respond(
          route.name,
          correlationId,
          await sendCommand(domain, principal, route, body.data, call),
          CommandResponseSchema,
        );
      }
      case "getDemo":
        return respond(
          route.name,
          correlationId,
          await getDemo(domain, route.siteId),
          DemoStateSchema,
        );
      case "setDemo": {
        const body = parseBody(event, DemoUpdateRequestSchema, CONTROL_BODY_MAX_BYTES);
        if (!body.ok) {
          return body.response;
        }
        return respond(
          route.name,
          correlationId,
          await setDemo(domain, principal, route.siteId, body.data, call),
          DemoStateSchema,
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
        logger.warn("control request refused", { reason: "no-console-role" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.noConsoleRole);
      }

      // The route and the path are checked before the role and the site: the JWT authorizer has already required a
      // valid token, and an unknown route or a malformed path reveals nothing about any site.
      const parsed = parseControlRoute(event.routeKey, event.pathParameters);
      if (!parsed.ok) {
        return parsed.reason === "unknown-route"
          ? problemResponse("not-found", 404, correlationId)
          : problemResponse("invalid-request", 400, correlationId, DETAIL.invalidPath);
      }
      const route = parsed.route;
      logger.appendKeys({ route: route.name });
      tracer.putAnnotation("route", route.name);

      const call = callOf(correlationId, context);
      const domain: ControlDeps = { ...ports, logger, metrics };

      // Every check below runs before the first store call of the request, the audit of a refusal excepted.
      if (!rolesOf(route.name).includes(principal.role)) {
        logger.warn("control request refused", { reason: "role" });
        await auditRoleRefusal(event, route, principal, call, domain);
        return problemResponse("forbidden", 403, correlationId, DETAIL.roleNotAllowed);
      }
      if (route.siteId !== principal.siteId) {
        logger.warn("control request refused", { reason: "site" });
        return problemResponse("forbidden", 403, correlationId, DETAIL.siteNotAllowed);
      }

      return await dispatch(event, route, principal, call, domain);
    } catch (error) {
      // The message of an unexpected error can carry an ARN or a request fragment: only its name is logged.
      logger.error("control request failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    } finally {
      metrics.publishStoredMetrics();
      // The keys belong to this invocation: a warm container must not carry them into the next one.
      logger.removeKeys(INVOCATION_LOG_KEYS);
    }
  };
}

/** Runtime resources the production ports are built from. */
export interface ControlRuntime {
  /** Document client of the function, traced. */
  readonly dynamo: ReturnType<typeof createDynamoDocumentClient>;
  /** Management client of the WebSocket stage, traced. */
  readonly management: ReturnType<typeof createManagementClient>;
  /** IoT data-plane client, traced. */
  readonly iot: ReturnType<typeof createIotDataClient>;
  /** Logger of the function. */
  readonly logger: HandlerLogger;
  /** Clock of the function. */
  readonly clock: Clock;
}

/**
 * Wires the domain ports of the control function to their production adapters. This is the only place that names the
 * adapters: a test that needs a different store builds its own ports, and the adapters stay behind the port types.
 *
 * @param env - The validated environment of the function.
 * @param runtime - The SDK clients, logger and clock the adapters are built on.
 * @returns The ports, without the per-invocation logger and metrics.
 */
export function createControlServices(
  env: ControlEnv,
  runtime: ControlRuntime,
): Omit<ControlDeps, "logger" | "metrics"> {
  const { dynamo, management, iot, logger, clock } = runtime;
  const ids: Ids = { uuidv7: () => uuidv7() };
  return {
    locks: new DynamoDbLockStore(dynamo, env.FLEET_TABLE_NAME),
    claims: new DynamoDbCommandClaims(dynamo, env.FLEET_TABLE_NAME),
    demo: new DynamoDbDemoStore(dynamo, env.FLEET_TABLE_NAME),
    robots: new DynamoDbRegistry(dynamo, env.FLEET_TABLE_NAME, logger),
    publisher: new IotCommandPublisher(iot),
    relay: createControlRelay({
      connections: new DynamoDbConnections(dynamo, env.CONNECTIONS_TABLE_NAME),
      push: new ApiGatewayPush(management, logger),
      clock,
      logger,
    }),
    audit: new DynamoDbAudit(dynamo, env.EVENTS_TABLE_NAME),
    clock,
    ids,
    randomBytes: (size) => randomBytes(size),
  };
}

/**
 * Adapts the Powertools metrics to the control counters. Each occurrence is added as one count; the handler publishes
 * the stored metrics once per invocation.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The control counters.
 */
function powertoolsControlMetrics(metrics: Metrics): ControlHandlerMetrics {
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
function annotationsOf(tracer: Tracer): ControlHandlerTracer {
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
function buildProductionHandler(observability: Observability): ControlHandler {
  const env = loadControlEnv(process.env);
  const logger = handlerLogger(observability.logger);
  const metrics = powertoolsControlMetrics(observability.metrics);
  const clock: Clock = { now: () => new Date() };
  const dynamo = createDynamoDocumentClient(env.AWS_REGION, observability.tracer);
  const management = observability.tracer.captureAWSv3Client(
    createManagementClient(env.WS_MANAGEMENT_ENDPOINT, env.AWS_REGION),
  );
  const iot = observability.tracer.captureAWSv3Client(
    createIotDataClient(env.IOT_DATA_ENDPOINT, env.AWS_REGION),
  );
  return createControlHandler({
    logger,
    metrics,
    tracer: annotationsOf(observability.tracer),
    ports: createControlServices(env, { dynamo, management, iot, logger, clock }),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: ControlHandler = buildProductionHandler(createObservability("control"));
