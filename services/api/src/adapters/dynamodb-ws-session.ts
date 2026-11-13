/**
 * WebSocket session store over the connections table: single-use tokens and connection records.
 *
 * Tokens and connections share the table with their own key prefixes (`WSTOKEN#`, `CONN#`). Neither carries the
 * `sitePk` index key, except a subscribed connection, so the site index lists subscribed connections only.
 * Redemption is one conditional delete that returns the old item: two concurrent redemptions cannot both succeed.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { RoleSchema, SiteIdSchema, UserSubSchema, type SiteId } from "@mfc/protocol";
import { z } from "zod";
import {
  ConnectionRecordSchema,
  WS_FRAME_LIMIT,
  WS_FRAME_WINDOW_MS,
  connectionExpiresAtSeconds,
  type ConnectionRecord,
} from "../domain/ws/session";
import {
  tokenExpiresAtSeconds,
  type RedeemedToken,
  type TokenRecord,
  type WsSessionStore,
} from "../domain/ws/token";
import { isAwsError } from "./aws-errors";

/** Prefix of the key of a token record. The key holds the hash, never the token. */
const TOKEN_KEY_PREFIX = "WSTOKEN#";

/** Prefix of the key of a connection record. */
const CONNECTION_KEY_PREFIX = "CONN#";

/** Attribute the site index keys on, set only on a subscribed connection. */
const SITE_KEY_ATTRIBUTE = "sitePk";

/** Stored token, as read back by the conditional delete. Read through this schema, never trusted as stored. */
const StoredTokenSchema = z.object({
  sub: UserSubSchema,
  role: RoleSchema,
  siteId: SiteIdSchema,
  sessionExpiresAtMs: z.int().min(0),
});

/**
 * Stored connection, as a consistent read returns it. The key is checked, so a record with another key cannot be
 * read as a connection.
 */
const StoredConnectionSchema = z.object({
  pk: z.string().regex(/^CONN#[A-Za-z0-9_=-]{6,32}$/),
  sub: UserSubSchema,
  role: RoleSchema,
  siteId: SiteIdSchema,
  connectedAtMs: z.int().min(0),
  sessionExpiresAtMs: z.int().min(0),
  subscribed: z.boolean(),
});

/**
 * Store of tokens and connections over DynamoDB.
 */
export class DynamoDbWsSession implements WsSessionStore {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The connections table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Stores a token record, keyed by its hash. A repeated hash fails: the store never overwrites a token.
   *
   * @param token - The record.
   * @throws On infrastructure errors and on a repeated hash.
   */
  async putToken(token: TokenRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `${TOKEN_KEY_PREFIX}${token.tokenHash}`,
          sub: token.sub,
          role: token.role,
          siteId: token.siteId,
          sessionExpiresAtMs: token.sessionExpiresAtMs,
          expiresAtMs: token.expiresAtMs,
          expiresAt: tokenExpiresAtSeconds(token.expiresAtMs),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  /**
   * Deletes a token atomically if it is present and not expired, and returns what it authorised.
   *
   * @param tokenHash - The SHA-256 hex digest of the token.
   * @param nowMs - The current instant, in epoch milliseconds.
   * @returns What the token authorised, or null when it is absent, expired or already used.
   * @throws On infrastructure errors, and when the stored item breaks its shape.
   */
  async redeemToken(tokenHash: string, nowMs: number): Promise<RedeemedToken | null> {
    try {
      const result = await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: `${TOKEN_KEY_PREFIX}${tokenHash}` },
          ConditionExpression: "attribute_exists(pk) AND expiresAtMs > :now",
          ExpressionAttributeValues: { ":now": nowMs },
          ReturnValues: "ALL_OLD",
        }),
      );
      if (result.Attributes === undefined) {
        return null;
      }
      const stored = StoredTokenSchema.parse(result.Attributes);
      return {
        sub: stored.sub,
        role: stored.role,
        siteId: stored.siteId,
        sessionExpiresAtMs: stored.sessionExpiresAtMs,
      };
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Stores a new connection record, not subscribed to any site.
   *
   * @param connection - The record.
   * @throws On infrastructure errors and on a repeated identifier.
   */
  async putConnection(connection: ConnectionRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `${CONNECTION_KEY_PREFIX}${connection.connectionId}`,
          sub: connection.sub,
          role: connection.role,
          siteId: connection.siteId,
          connectedAtMs: connection.connectedAtMs,
          sessionExpiresAtMs: connection.sessionExpiresAtMs,
          subscribed: false,
          expiresAt: connectionExpiresAtSeconds(connection),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  /**
   * Reads a connection record with a consistent read, so a `subscribe` right after `$connect` sees it.
   *
   * @param connectionId - The connection.
   * @returns The record, or null when it does not exist.
   * @throws On infrastructure errors and when the stored item breaks its shape.
   */
  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `${CONNECTION_KEY_PREFIX}${connectionId}` },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    const stored = StoredConnectionSchema.parse(result.Item);
    return ConnectionRecordSchema.parse({
      connectionId: stored.pk.slice(CONNECTION_KEY_PREFIX.length),
      sub: stored.sub,
      role: stored.role,
      siteId: stored.siteId,
      connectedAtMs: stored.connectedAtMs,
      sessionExpiresAtMs: stored.sessionExpiresAtMs,
      subscribed: stored.subscribed,
    });
  }

  /**
   * Marks a connection as subscribed to a site, which adds it to the site index.
   *
   * @param connectionId - The connection.
   * @param siteId - The site.
   * @returns False when the record does not exist (it was removed by a disconnect).
   * @throws On infrastructure errors.
   */
  async subscribe(connectionId: string, siteId: SiteId): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `${CONNECTION_KEY_PREFIX}${connectionId}` },
          UpdateExpression: `SET subscribed = :subscribed, ${SITE_KEY_ATTRIBUTE} = :site`,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":subscribed": true, ":site": `SITE#${siteId}` },
        }),
      );
      return true;
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Removes a connection record. Removing an absent record succeeds.
   *
   * @param connectionId - The connection.
   * @throws On infrastructure errors.
   */
  async remove(connectionId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `${CONNECTION_KEY_PREFIX}${connectionId}` },
      }),
    );
  }

  /**
   * Counts one client frame in the connection's window. The first frame of a window (or of a new window, once the
   * previous one is over) starts it; a later frame increments the count while it is below the limit. Each step is
   * one conditional update, so the count never passes the limit under concurrent frames.
   *
   * @param connectionId - The connection.
   * @param nowMs - The current instant, in epoch milliseconds.
   * @returns `true` when the frame is within the limit, `false` when the window is full or the record is absent.
   * @throws On infrastructure errors.
   */
  async countFrame(connectionId: string, nowMs: number): Promise<boolean> {
    const key = { pk: `${CONNECTION_KEY_PREFIX}${connectionId}` };
    const windowStartBefore = nowMs - WS_FRAME_WINDOW_MS;
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: "SET frameWindowMs = :now, frameCount = :one",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(frameWindowMs) OR frameWindowMs <= :before)",
          ExpressionAttributeValues: { ":now": nowMs, ":one": 1, ":before": windowStartBefore },
        }),
      );
      return true;
    } catch (error) {
      if (!isAwsError(error, "ConditionalCheckFailedException")) {
        throw error;
      }
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: "SET frameCount = frameCount + :one",
          ConditionExpression:
            "attribute_exists(pk) AND frameWindowMs > :before AND frameCount < :limit",
          ExpressionAttributeValues: {
            ":one": 1,
            ":before": windowStartBefore,
            ":limit": WS_FRAME_LIMIT,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return false;
      }
      throw error;
    }
  }
}
