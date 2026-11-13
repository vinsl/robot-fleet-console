/**
 * Pushes frames to WebSocket connections through the API Gateway management API.
 *
 * A push never throws: a connection that is gone is reported as such, and any other failure as `FAILED`, with
 * the error name only. The connection identifier is not logged: it is an internal key, and only counts leave
 * the function.
 */
import {
  DeleteConnectionCommand,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { PushPort, PushResult } from "../domain/live/ports";
import type { DomainLogger } from "../domain/ports";
import { safeErrorFields } from "../domain/safe-error";
import { isAwsError } from "./aws-errors";

/** Push over the API Gateway management API. */
export class ApiGatewayPush implements PushPort {
  /**
   * @param client - The management client. Only `send` is used, so tests can supply a double.
   * @param logger - Logger of the failures, by error name only.
   */
  constructor(
    private readonly client: Pick<ApiGatewayManagementApiClient, "send">,
    private readonly logger: DomainLogger,
  ) {}

  /**
   * Posts one frame to a connection.
   *
   * @param connectionId - The connection.
   * @param data - The serialised frame.
   * @returns `SENT`, `GONE` when the connection no longer exists, or `FAILED`.
   */
  async post(connectionId: string, data: string): Promise<PushResult> {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(data, "utf8"),
        }),
      );
      return "SENT";
    } catch (error) {
      if (isAwsError(error, "GoneException")) {
        return "GONE";
      }
      this.logger.warn("push failed", safeErrorFields(error));
      return "FAILED";
    }
  }

  /**
   * Closes a connection from the server side. An absent connection is already closed; any other failure is
   * logged by name and swallowed, since the record expires by TTL anyway.
   *
   * @param connectionId - The connection.
   */
  async close(connectionId: string): Promise<void> {
    try {
      await this.client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (error) {
      if (!isAwsError(error, "GoneException")) {
        this.logger.warn("connection close failed", safeErrorFields(error));
      }
    }
  }
}
