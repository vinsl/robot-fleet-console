/**
 * WebSocket connections over DynamoDB: one item per connection in the connections table, found by site
 * through the sparse `bySite` index. Only subscribed connections carry the index key, so the index holds
 * exactly the connections that receive fleet data.
 */
import { DeleteCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { RoleSchema, type SiteId } from "@mfc/protocol";
import { z } from "zod";
import type { ConnectionRef, ConnectionsPort, SubscribedConnections } from "../domain/live/ports";

/** Name of the index that lists the subscribed connections of a site. */
const SITE_INDEX = "bySite";

/** Items read per page of the listing. */
const PAGE_SIZE = 100;

/** Pages read per listing: at most 300 connections of one site per invocation. */
const MAX_PAGES = 3;

/**
 * A stored connection, as the index projects it: the key, the index keys (`sitePk`), and the attributes the
 * index includes. Not strict: the index returns its own keys, which this reader does not use. Read through this
 * schema, never trusted as stored.
 */
const StoredConnectionSchema = z.object({
  pk: z.string().regex(/^CONN#[A-Za-z0-9_=-]{6,32}$/),
  role: RoleSchema,
  sessionExpiresAtMs: z.int().min(0),
});

/**
 * Converts a stored connection into the port's reference.
 *
 * @param item - The index item.
 * @returns The reference, with the connection identifier taken from the key.
 * @throws {ZodError} When the item breaks the stored shape: the store is then wrong, so the listing fails
 * instead of serving a session it cannot read.
 */
function connectionOf(item: unknown): ConnectionRef {
  const stored = StoredConnectionSchema.parse(item);
  return {
    connectionId: stored.pk.slice("CONN#".length),
    role: stored.role,
    sessionExpiresAtMs: stored.sessionExpiresAtMs,
  };
}

/** Connection records over the connections table. */
export class DynamoDbConnections implements ConnectionsPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The connections table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Lists the connections subscribed to a site, reading at most {@link MAX_PAGES} pages.
   *
   * @param siteId - The site.
   * @returns The connections, and whether the listing stopped before the end.
   * @throws On infrastructure errors, or when a stored item breaks its shape.
   */
  async listSubscribed(siteId: SiteId): Promise<SubscribedConnections> {
    const connections: ConnectionRef[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: SITE_INDEX,
          KeyConditionExpression: "sitePk = :site",
          ExpressionAttributeValues: { ":site": `SITE#${siteId}` },
          Limit: PAGE_SIZE,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of result.Items ?? []) {
        connections.push(connectionOf(item));
      }
      startKey = result.LastEvaluatedKey;
      if (startKey === undefined) {
        return { connections, truncated: false };
      }
    }
    return { connections, truncated: true };
  }

  /**
   * Removes a connection record. Removing an absent record succeeds.
   *
   * @param connectionId - The connection identifier.
   * @throws On infrastructure errors.
   */
  async remove(connectionId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `CONN#${connectionId}` },
      }),
    );
  }
}
