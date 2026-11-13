/**
 * Control state over DynamoDB, in the fleet table: the idempotency claims of the commands and lock requests, and the
 * demo flag of a site.
 *
 * A claim is one conditional put, so the first request with an identifier wins and a replay reads the stored claim. The
 * flag has no item until it is first switched, and an absent item reads as disabled.
 */
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  CommandTypeSchema,
  CorrelationIdSchema,
  DemoStateSchema,
  IsoMsSchema,
  RobotIdSchema,
  UserSubSchema,
  Uuidv7Schema,
  type DemoState,
  type SiteId,
  type Uuidv7,
} from "@mfc/protocol";
import { z } from "zod";
import type {
  CommandClaim,
  CommandClaimOutcome,
  CommandClaimPort,
  DemoStorePort,
} from "../domain/control/ports";
import { isAwsError } from "./aws-errors";

/**
 * Stored form of a claim, without its keys and its expiry. Strict, so a stored claim that gained a field is refused
 * rather than replayed with data nobody checked.
 */
const StoredClaimSchema = z.strictObject({
  commandId: Uuidv7Schema,
  robotId: RobotIdSchema,
  type: CommandTypeSchema,
  actor: UserSubSchema,
  correlationId: CorrelationIdSchema,
  issuedAt: IsoMsSchema,
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
 * Sort key of a claim.
 *
 * @param commandId - The client identifier of the request.
 * @returns The sort key.
 */
function claimSortKey(commandId: Uuidv7): string {
  return `CMD#${commandId}`;
}

/** Idempotency claims over the fleet table. */
export class DynamoDbCommandClaims implements CommandClaimPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Claims an identifier with a conditional put. When the identifier was claimed before, the stored claim is read back
   * with a consistent read, so the caller can compare it with the new request.
   *
   * @param siteId - The site of the request.
   * @param claim - The request to claim.
   * @param expiresAtSeconds - Retention of the claim, in epoch seconds (the table TTL attribute).
   * @returns `CLAIMED`, or `EXISTS` with the stored claim.
   * @throws When the stored claim cannot be read back or does not match its schema.
   */
  async claim(
    siteId: SiteId,
    claim: CommandClaim,
    expiresAtSeconds: number,
  ): Promise<CommandClaimOutcome> {
    const key = { pk: sitePartition(siteId), sk: claimSortKey(claim.commandId) };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...key,
            commandId: claim.commandId,
            robotId: claim.robotId,
            type: claim.type,
            actor: claim.actor,
            correlationId: claim.correlationId,
            issuedAt: claim.issuedAt,
            expiresAt: expiresAtSeconds,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { kind: "CLAIMED" };
    } catch (error) {
      if (!isAwsError(error, "ConditionalCheckFailedException")) {
        throw error;
      }
    }
    const output = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
    );
    const item: Record<string, unknown> | undefined = output.Item;
    if (item === undefined) {
      throw new Error("claimed command has no stored item");
    }
    const stored = StoredClaimSchema.safeParse({
      commandId: item.commandId,
      robotId: item.robotId,
      type: item.type,
      actor: item.actor,
      correlationId: item.correlationId,
      issuedAt: item.issuedAt,
    });
    if (!stored.success) {
      throw new Error("stored command claim does not match its schema");
    }
    return { kind: "EXISTS", claim: stored.data };
  }

  /**
   * Removes a claim of a request that failed before any effect.
   *
   * @param siteId - The site of the request.
   * @param commandId - The client identifier of the request.
   */
  async abandon(siteId: SiteId, commandId: Uuidv7): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: sitePartition(siteId), sk: claimSortKey(commandId) },
      }),
    );
  }
}

/** Demo flag of a site over the fleet table. */
export class DynamoDbDemoStore implements DemoStorePort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Reads the flag with a consistent read: a fault injection must not pass on a flag switched off a moment ago.
   *
   * @param siteId - The site.
   * @returns The stored flag, or the disabled state when there is no item.
   * @throws When the stored item does not match the demo schema.
   */
  async get(siteId: SiteId): Promise<DemoState> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: sitePartition(siteId), sk: "DEMO" },
        ConsistentRead: true,
      }),
    );
    const item: Record<string, unknown> | undefined = output.Item;
    if (item === undefined) {
      return { enabled: false };
    }
    // Only the state fields are checked: the keys of the item are not part of the state.
    const parsed = DemoStateSchema.safeParse({
      enabled: item.enabled,
      changedBy: item.changedBy,
      changedAt: item.changedAt,
    });
    if (!parsed.success) {
      throw new Error("stored demo item does not match its schema");
    }
    return parsed.data;
  }

  /**
   * Stores the flag. The input is validated before it is written.
   *
   * @param siteId - The site.
   * @param next - The state to store.
   * @returns The state as stored.
   */
  async set(siteId: SiteId, next: DemoState): Promise<DemoState> {
    const state = DemoStateSchema.parse(next);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: sitePartition(siteId), sk: "DEMO", ...state },
      }),
    );
    return state;
  }
}
