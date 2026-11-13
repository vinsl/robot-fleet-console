/**
 * Robot registry over DynamoDB: the claim of each robot id and the record of each robot, both in the
 * fleet table.
 *
 * The claim item makes a robot id unique across sites, because the thing name is global. Both items
 * are written in one transaction, so a crash cannot leave a claim without its record or the reverse.
 * Every later change is a conditional write on the record version, which is how the domain detects a
 * concurrent writer.
 */
import { isDeepStrictEqual } from "node:util";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import type { RobotId, SiteId } from "@mfc/protocol";
import type { DomainLogger, RegistryPort, ReplaceOutcome, ReserveOutcome } from "../domain/ports";
import { RobotsError } from "../domain/robots/problems";
import { RobotRecordSchema, type RobotRecord } from "../domain/robots/registry";
import { isAwsError } from "./aws-errors";

/** Partition and sort key attributes of the fleet table. Stripped before a record is validated. */
const KEY_ATTRIBUTES = ["pk", "sk"] as const;

/**
 * Partition key of a site's robot record.
 *
 * @param siteId - The site of the robot.
 * @returns The partition key, `SITE#<siteId>`.
 */
function sitePartition(siteId: SiteId): string {
  return `SITE#${siteId}`;
}

/**
 * Sort key of a robot record within its site.
 *
 * @param robotId - The robot identifier.
 * @returns The sort key, `ROBOT#<robotId>`.
 */
function robotSortKey(robotId: RobotId): string {
  return `ROBOT#${robotId}`;
}

/**
 * Builds the stored item of a robot record, keys included.
 *
 * @param record - The record to store.
 * @returns The item. Optional fields left undefined are dropped by the document client.
 */
function robotItem(record: RobotRecord): Record<string, unknown> {
  return {
    pk: sitePartition(record.siteId),
    sk: robotSortKey(record.robotId),
    ...record,
  };
}

/**
 * Builds the claim item that reserves a robot id for its site.
 *
 * @param record - The record being created.
 * @returns The claim item, keyed by the robot id.
 */
function claimItem(record: RobotRecord): Record<string, unknown> {
  return {
    pk: `ROBOTID#${record.robotId}`,
    sk: "CLAIM",
    siteId: record.siteId,
    createdAt: record.createdAt,
  };
}

/**
 * Reads a stored item back as a robot record.
 *
 * @param item - The stored item, keys included.
 * @returns The record, or undefined when the item does not match the schema.
 */
function recordOfItem(item: Record<string, unknown>): RobotRecord | undefined {
  const fields = Object.fromEntries(
    Object.entries(item).filter(([key]) => !(KEY_ATTRIBUTES as readonly string[]).includes(key)),
  );
  const parsed = RobotRecordSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Normalises a record for comparison: a JSON round trip drops the keys whose value is undefined, so an
 * absent optional field and an undefined one compare equal, as they do once stored.
 *
 * @param record - A record.
 * @returns A plain copy of the record.
 */
function plainRecord(record: RobotRecord): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(record));
  return copy;
}

/**
 * Tells whether a conditional write was refused because the stored record already equals the one it
 * tried to write. That is the signature of an SDK retry of a write that landed.
 *
 * @param stored - The record found in the table, or undefined.
 * @param next - The record the write tried to store.
 * @returns True when both records are the same.
 */
function isSameRecord(stored: RobotRecord | undefined, next: RobotRecord): boolean {
  return stored !== undefined && isDeepStrictEqual(plainRecord(stored), plainRecord(next));
}

/**
 * Tells whether a failed transaction failed because one of its conditions did not hold.
 *
 * @param error - The rejection of the transaction.
 * @returns True when a cancellation reason is `ConditionalCheckFailed`; false for any other failure.
 */
function isClaimTaken(error: unknown): boolean {
  if (!isAwsError(error, "TransactionCanceledException")) {
    return false;
  }
  if (typeof error !== "object" || error === null || !("CancellationReasons" in error)) {
    return false;
  }
  if (!Array.isArray(error.CancellationReasons)) {
    return false;
  }
  const reasons: unknown[] = error.CancellationReasons;
  return reasons.some(
    (reason) =>
      typeof reason === "object" &&
      reason !== null &&
      "Code" in reason &&
      reason.Code === "ConditionalCheckFailed",
  );
}

/** Robot items read per page of the registry list. */
const LIST_PAGE_SIZE = 50;

/**
 * Pages read by the registry list. Two pages of 50 cover the 100 robots a list response can carry, so a site
 * with more robots is cut at the bound rather than read without limit.
 */
const LIST_MAX_PAGES = 2;

/** Registry of robots over the fleet table of the demo stack. */
export class DynamoDbRegistry implements RegistryPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   * @param logger - Receives a count of the stored items that were left out of a list. Optional: the robots
   * function does not list, so it passes none.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
    private readonly logger?: Pick<DomainLogger, "warn">,
  ) {}

  /**
   * Lists the robot records of a site, bounded to {@link LIST_MAX_PAGES} pages. A stored item that does not match
   * the record schema is left out and counted in the log, so one bad item never blanks the whole list.
   *
   * @param siteId - The site whose robots are listed.
   * @returns The records read, in the order of the table.
   */
  async list(siteId: SiteId): Promise<RobotRecord[]> {
    const records: RobotRecord[] = [];
    let skipped = 0;
    let startKey: QueryCommandOutput["LastEvaluatedKey"];
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const output: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :site AND begins_with(sk, :robot)",
          ExpressionAttributeValues: { ":site": sitePartition(siteId), ":robot": "ROBOT#" },
          Limit: LIST_PAGE_SIZE,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of output.Items ?? []) {
        const record = recordOfItem(item);
        if (record === undefined) {
          skipped += 1;
        } else {
          records.push(record);
        }
      }
      if (output.LastEvaluatedKey === undefined) {
        break;
      }
      startKey = output.LastEvaluatedKey;
    }
    if (skipped > 0) {
      this.logger?.warn("registry items left out of the list", { count: skipped });
    }
    return records;
  }

  /**
   * Claims the id and writes the record in one transaction. The request token makes an SDK retry of the
   * same transaction succeed instead of finding its own claim.
   *
   * @param record - The record to create.
   * @param clientRequestToken - Idempotency token of the transaction.
   * @returns `taken` when either item already exists; `reserved` otherwise.
   */
  async reserve(record: RobotRecord, clientRequestToken: string): Promise<ReserveOutcome> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: clientRequestToken,
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: claimItem(record),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: robotItem(record),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return "reserved";
    } catch (error) {
      if (isClaimTaken(error)) {
        return "taken";
      }
      throw error;
    }
  }

  /**
   * Strongly consistent read of one record.
   *
   * @param siteId - The site of the robot.
   * @param robotId - The robot identifier.
   * @returns The record, or null when the site has no robot with this id.
   * @throws {RobotsError} With code `internal` when the stored item does not match the record schema.
   */
  async get(siteId: SiteId, robotId: RobotId): Promise<RobotRecord | null> {
    const item = await this.readItem(siteId, robotId);
    if (item === undefined) {
      return null;
    }
    const record = recordOfItem(item);
    if (record === undefined) {
      throw new RobotsError("internal");
    }
    return record;
  }

  /**
   * Strongly consistent read of the stored item of a robot, keys included.
   *
   * @param siteId - The site of the robot.
   * @param robotId - The robot identifier.
   * @returns The stored item, or undefined when there is none.
   */
  private async readItem(
    siteId: SiteId,
    robotId: RobotId,
  ): Promise<Record<string, unknown> | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: sitePartition(siteId), sk: robotSortKey(robotId) },
        ConsistentRead: true,
      }),
    );
    return output.Item;
  }

  /**
   * Replaces a record if its stored version is the expected one. A refused write whose stored record
   * already equals `next` is a retry of our own write, and counts as applied.
   *
   * The refused write does not carry the stored item: lib-dynamodb unmarshalls only successful outputs,
   * so the item on the error is the raw attribute map. The stored record is therefore read back with a
   * strongly consistent read, which is also the only way to see a record written by another caller.
   *
   * @param expectedVersion - The version the caller read.
   * @param next - The record to store.
   * @returns `ok` when stored (or already stored by a retry); `conflict` otherwise.
   */
  async replace(expectedVersion: number, next: RobotRecord): Promise<ReplaceOutcome> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: robotItem(next),
          ConditionExpression: "#version = :expected",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":expected": expectedVersion },
        }),
      );
      return "ok";
    } catch (error) {
      if (!isAwsError(error, "ConditionalCheckFailedException")) {
        throw error;
      }
      const storedItem = await this.readItem(next.siteId, next.robotId);
      const stored = storedItem === undefined ? undefined : recordOfItem(storedItem);
      return isSameRecord(stored, next) ? "ok" : "conflict";
    }
  }
}
