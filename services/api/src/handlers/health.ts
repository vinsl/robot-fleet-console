/**
 * Lambda entry point of the `health` function: the public liveness report behind `GET /health`.
 *
 * The route has no authorizer, so the handler is the only thing between the internet and the response. It reads
 * no header and no body, makes no AWS call, and returns the report the domain builds. The version is read once at
 * cold start from the deployment environment, and a malformed value stops the function from starting.
 */
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { getCorrelationId, jsonResponse, problemResponse, type HttpResult } from "../adapters/http";
import { buildHealthReport } from "../domain/health";
import type { Clock } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import { loadHealthEnv } from "../config/env";
import { createObservability, handlerLogger, type HandlerLogger } from "../observability";

/** Everything the handler needs. Production passes the environment version, the clock and the logger. */
export interface HealthHandlerDeps {
  /** Application version reported to clients. */
  readonly version: string;
  /** Clock of the report timestamp. */
  readonly clock: Clock;
  /** Logger of failures. */
  readonly logger: HandlerLogger;
}

/** The Lambda handler of the `health` function. */
export type HealthHandler = (event: APIGatewayProxyEventV2) => HttpResult;

/**
 * Builds the handler over its dependencies.
 *
 * @param deps - The version, the clock and the logger.
 * @returns The Lambda handler. A failure is a `500` with no internal text.
 */
export function createHealthHandler(deps: HealthHandlerDeps): HealthHandler {
  return (event) => {
    const correlationId = getCorrelationId(event);
    try {
      const report = buildHealthReport({ version: deps.version, now: deps.clock.now() });
      return jsonResponse(200, report, correlationId);
    } catch (error) {
      deps.logger.error("health report failed", safeErrorFields(error));
      return problemResponse("internal", 500, correlationId);
    }
  };
}

/** The Lambda handler, built once per cold start. A malformed `APP_VERSION` throws here, so the function never starts. */
export const handler: HealthHandler = createHealthHandler({
  version: loadHealthEnv(process.env).APP_VERSION,
  clock: { now: () => new Date() },
  logger: handlerLogger(createObservability("health").logger),
});
