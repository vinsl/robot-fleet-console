/**
 * Lambda entry point of the `ws-message` function: the `$default` route, which carries every client frame.
 *
 * The frame is dispatched in the domain on its parsed type. The management endpoint is not in the environment: the
 * function derives it from the request context of each event, after checking that it names a stage of this region.
 * An event that cannot be read, or a request context of another region, is a failure: the function throws, and API
 * Gateway answers the client with an error. Refusals of a frame are not failures: they are error frames to the client.
 *
 * The frame body is never logged.
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { uuidv7, type AwsRegion } from "@mfc/protocol";
import type { Context } from "aws-lambda";
import { z } from "zod";
import { ApiGatewayPush } from "../adapters/apigw-push";
import { DynamoDbFleetState } from "../adapters/dynamodb-fleet-state";
import { DynamoDbLockStore } from "../adapters/dynamodb-lock";
import { createIotDataClient, IotCommandPublisher } from "../adapters/iot-publisher";
import { DynamoDbWsSession } from "../adapters/dynamodb-ws-session";
import { createDynamoDocumentClient, createManagementClient } from "../adapters/clients";
import { loadWsMessageEnv } from "../config/env";
import type { CommandPublisherPort, LockStorePort } from "../domain/control/ports";
import type { FleetStatePort, PushPort } from "../domain/live/ports";
import type { Clock, Ids } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import { handleClientMessage } from "../domain/ws/dispatch";
import { HeartbeatLogThrottle } from "../domain/ws/heartbeat";
import type { WsMetricsPort } from "../domain/ws/metrics";
import { managementEndpointOf } from "../domain/ws/endpoint";
import { ConnectionIdSchema } from "../domain/ws/session";
import type { WsSessionStore } from "../domain/ws/token";
import {
  createObservability,
  handlerLogger,
  wsMetricsOf,
  type HandlerLogger,
  type Observability,
} from "../observability";

/**
 * The parts of the `$default` proxy event this function reads. The request context names the stage that
 * delivered the frame; the domain name is validated before any use.
 */
const MessageEventSchema = z.object({
  body: z.string().nullish(),
  requestContext: z.object({
    connectionId: ConnectionIdSchema,
    domainName: z.string().max(253),
    stage: z.string().max(128),
  }),
});

/** Result of an invocation. API Gateway ignores it apart from the status. */
export interface WsMessageResult {
  readonly statusCode: 200;
}

/** The Lambda handler of the `ws-message` function. */
export type WsMessageHandler = (event: unknown, context: Context) => Promise<WsMessageResult>;

/** Everything the handler needs. */
export interface WsMessageDeps {
  readonly store: WsSessionStore;
  readonly fleet: FleetStatePort;
  readonly clock: Clock;
  readonly logger: HandlerLogger;
  readonly metrics: WsMetricsPort;
  /** The region the function runs in. A request context of another region is refused. */
  readonly region: AwsRegion;
  /** Builds the push port of the management endpoint of a stage. */
  readonly pushFor: (endpoint: string) => PushPort;
  /** Robot lock store, read on every heartbeat. */
  readonly locks: LockStorePort;
  /** Publisher of the `HEARTBEAT` commands. */
  readonly publisher: CommandPublisherPort;
  /** Source of identifiers of the published heartbeats. */
  readonly ids: Ids;
  /** Log throttle of the heartbeat path, one per function instance. */
  readonly logThrottle: Pick<HeartbeatLogThrottle, "allow">;
}

/** Key this handler appends to the logger for one invocation, removed when it ends. */
const INVOCATION_LOG_KEY = "correlationId";

/**
 * Builds the handler over its ports.
 *
 * @param deps - The ports and the observers.
 * @returns The Lambda handler. It resolves with status 200 once the frame is handled, and throws on an
 * unreadable event or an infrastructure failure.
 */
export function createWsMessageHandler(deps: WsMessageDeps): WsMessageHandler {
  return async (event, context) => {
    deps.logger.appendKeys({ [INVOCATION_LOG_KEY]: context.awsRequestId });
    try {
      const parsed = MessageEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error("ws-message event does not match the WebSocket proxy shape");
      }
      const endpoint = managementEndpointOf(parsed.data.requestContext, deps.region);
      if (endpoint === null) {
        throw new Error("ws-message request context does not name a stage of this region");
      }
      await handleClientMessage(
        { body: parsed.data.body, connectionId: parsed.data.requestContext.connectionId },
        {
          store: deps.store,
          fleet: deps.fleet,
          push: deps.pushFor(endpoint),
          clock: deps.clock,
          logger: deps.logger,
          metrics: deps.metrics,
          heartbeat: {
            locks: deps.locks,
            publisher: deps.publisher,
            clock: deps.clock,
            ids: deps.ids,
            logger: deps.logger,
            metrics: deps.metrics,
            logThrottle: deps.logThrottle,
          },
        },
      );
      return { statusCode: 200 };
    } catch (error) {
      deps.logger.error("message handling failed", safeErrorFields(error));
      // A fresh error, with no cause: the SDK message can carry a table or an endpoint name, and the safe fields
      // of the original error are logged above.
      // eslint-disable-next-line preserve-caught-error -- attaching the original error would keep its SDK message
      throw new Error("message handling failed");
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
function buildProductionHandler(observability: Observability): WsMessageHandler {
  const env = loadWsMessageEnv(process.env);
  const logger = handlerLogger(observability.logger);
  const clock: Clock = { now: () => new Date() };
  const dynamo: DynamoDBDocumentClient = createDynamoDocumentClient(
    env.AWS_REGION,
    observability.tracer,
  );
  const iot = observability.tracer.captureAWSv3Client(
    createIotDataClient(env.IOT_DATA_ENDPOINT, env.AWS_REGION),
  );
  return createWsMessageHandler({
    store: new DynamoDbWsSession(dynamo, env.CONNECTIONS_TABLE_NAME),
    locks: new DynamoDbLockStore(dynamo, env.FLEET_TABLE_NAME),
    publisher: new IotCommandPublisher(iot),
    ids: { uuidv7: () => uuidv7() },
    logThrottle: new HeartbeatLogThrottle(),
    fleet: new DynamoDbFleetState(dynamo, env.FLEET_TABLE_NAME, clock),
    clock,
    logger,
    metrics: wsMetricsOf(observability.metrics),
    region: env.AWS_REGION,
    pushFor: (endpoint) =>
      new ApiGatewayPush(
        observability.tracer.captureAWSv3Client(createManagementClient(endpoint, env.AWS_REGION)),
        logger,
      ),
  });
}

/** The Lambda handler, built once per cold start. */
export const handler: WsMessageHandler = buildProductionHandler(createObservability("ws-message"));
