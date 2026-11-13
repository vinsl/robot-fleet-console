/**
 * Robot lock over DynamoDB: one item per robot in the fleet table, written only under conditions the store checks.
 *
 * The condition, not the code, is what keeps two operators from holding one robot: an acquire is one conditional put,
 * a refresh and a release are conditional on the holder and the token. The token is stored here and nowhere else; it
 * never leaves the API (ADR 0062).
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  IsoMsSchema,
  LockTokenSchema,
  UserSubSchema,
  type LockToken,
  type RobotId,
  type SiteId,
  type UserSub,
} from "@mfc/protocol";
import { z } from "zod";
import type { LockAcquireOutcome, LockItem, LockStorePort } from "../domain/control/ports";
import { isAwsError } from "./aws-errors";

/**
 * Stored form of a lock item, without its keys. Strict: an unknown attribute on a lock item is a corrupt item, and the
 * caller fails closed rather than trusting it.
 */
const StoredLockSchema = z.strictObject({
  holder: UserSubSchema,
  token: LockTokenSchema,
  acquiredAt: IsoMsSchema,
  expiresAt: z.int().min(0),
});

/**
 * Partition key of a site, the same one the registry uses.
 *
 * @param siteId - The site.
 * @returns The partition key.
 */
function sitePartition(siteId: SiteId): string {
  return `SITE#${siteId}`;
}

/**
 * Sort key of a robot's lock.
 *
 * @param robotId - The robot.
 * @returns The sort key.
 */
function lockSortKey(robotId: RobotId): string {
  return `LOCK#${robotId}`;
}

/**
 * Lock store over the fleet table.
 */
export class DynamoDbLockStore implements LockStorePort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Strongly consistent read of the lock item. A consistent read is what lets a holder check see an acquire that
   * just completed on another instance.
   *
   * @param siteId - The site of the robot.
   * @param robotId - The robot.
   * @returns The item, or null when there is none.
   * @throws When the stored item does not match the lock schema: the caller fails closed.
   */
  async get(siteId: SiteId, robotId: RobotId): Promise<LockItem | null> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: sitePartition(siteId), sk: lockSortKey(robotId) },
        ConsistentRead: true,
      }),
    );
    const item: Record<string, unknown> | undefined = output.Item;
    if (item === undefined) {
      return null;
    }
    const stored = StoredLockSchema.safeParse({
      holder: item.holder,
      token: item.token,
      acquiredAt: item.acquiredAt,
      expiresAt: item.expiresAt,
    });
    if (!stored.success) {
      throw new Error("stored lock item does not match its schema");
    }
    return { robotId, ...stored.data };
  }

  /**
   * Writes the lock when it is free, expired or already the caller's. The previous item is returned by the write, so
   * the outcome says whether the caller already held a live lock.
   *
   * @param siteId - The site of the robot.
   * @param next - The lock to write.
   * @param nowSeconds - The current instant in epoch seconds, compared with the stored expiry.
   * @returns `HELD` when another live holder keeps the item, `REFRESHED` when the caller already held it live,
   * `ACQUIRED` otherwise.
   */
  async acquire(siteId: SiteId, next: LockItem, nowSeconds: number): Promise<LockAcquireOutcome> {
    try {
      const output = await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: sitePartition(siteId),
            sk: lockSortKey(next.robotId),
            holder: next.holder,
            token: next.token,
            acquiredAt: next.acquiredAt,
            expiresAt: next.expiresAt,
          },
          ConditionExpression: "attribute_not_exists(pk) OR #expiresAt <= :now OR #holder = :me",
          ExpressionAttributeNames: { "#expiresAt": "expiresAt", "#holder": "holder" },
          ExpressionAttributeValues: { ":now": nowSeconds, ":me": next.holder },
          ReturnValues: "ALL_OLD",
        }),
      );
      const previous = output.Attributes;
      const wasLiveOwn =
        previous !== undefined &&
        previous.holder === next.holder &&
        typeof previous.expiresAt === "number" &&
        previous.expiresAt > nowSeconds;
      return wasLiveOwn ? "REFRESHED" : "ACQUIRED";
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return "HELD";
      }
      throw error;
    }
  }

  /**
   * Moves the expiry of a live lock the caller holds.
   *
   * @returns `true` when the item was updated; `false` when the holder, the token or the liveness no longer match.
   */
  async refresh(
    siteId: SiteId,
    robotId: RobotId,
    holder: UserSub,
    token: LockToken,
    expiresAtSeconds: number,
    nowSeconds: number,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: sitePartition(siteId), sk: lockSortKey(robotId) },
          UpdateExpression: "SET #expiresAt = :expires",
          ConditionExpression: "#holder = :holder AND #token = :token AND #expiresAt > :now",
          ExpressionAttributeNames: {
            "#expiresAt": "expiresAt",
            "#holder": "holder",
            "#token": "token",
          },
          ExpressionAttributeValues: {
            ":expires": expiresAtSeconds,
            ":holder": holder,
            ":token": token,
            ":now": nowSeconds,
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

  /**
   * Deletes the lock when the caller still holds it with this token.
   *
   * @returns `true` when the item was deleted; `false` when the holder or the token no longer match.
   */
  async release(
    siteId: SiteId,
    robotId: RobotId,
    holder: UserSub,
    token: LockToken,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: sitePartition(siteId), sk: lockSortKey(robotId) },
          ConditionExpression: "#holder = :holder AND #token = :token",
          ExpressionAttributeNames: { "#holder": "holder", "#token": "token" },
          ExpressionAttributeValues: { ":holder": holder, ":token": token },
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
