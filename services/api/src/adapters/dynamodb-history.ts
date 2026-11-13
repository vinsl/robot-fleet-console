/**
 * Robot history over DynamoDB, in the events table: one item per state change and one per completed
 * mission. Items expire after the retention of their kind, through the table's TTL attribute.
 *
 * Each item is keyed by site, time and message identifier, so a redelivered message finds its own item and
 * the write is refused as a duplicate.
 */
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MISSION_RECORD_RETENTION_SECONDS, STATE_RECORD_RETENTION_SECONDS } from "@mfc/protocol";
import { isAwsError } from "./aws-errors";
import type {
  HistoryPort,
  HistoryWriteOutcome,
  MissionHistoryRecord,
  StateHistoryRecord,
} from "../domain/live/ports";

/**
 * Converts a UTC millisecond time to epoch seconds, for the TTL attribute.
 *
 * @param ts - The time, in the fixed UTC format.
 * @returns Whole seconds since the epoch.
 */
function epochSecondsOf(ts: string): number {
  return Math.floor(Date.parse(ts) / 1000);
}

/**
 * Writes one item, refusing an existing key.
 *
 * @param client - The document client.
 * @param tableName - The events table.
 * @param item - The item.
 * @returns `WRITTEN`, or `DUPLICATE` when the key exists.
 * @throws On any other failure.
 */
async function putOnce(
  client: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  item: Record<string, unknown>,
): Promise<HistoryWriteOutcome> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return "WRITTEN";
  } catch (error) {
    if (isAwsError(error, "ConditionalCheckFailedException")) {
      return "DUPLICATE";
    }
    throw error;
  }
}

/** Robot history over the events table. */
export class DynamoDbHistory implements HistoryPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The events table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Stores one state change.
   *
   * @param record - The state change.
   * @returns `WRITTEN`, or `DUPLICATE` for a repeated message.
   * @throws On infrastructure errors.
   */
  putState(record: StateHistoryRecord): Promise<HistoryWriteOutcome> {
    return putOnce(this.client, this.tableName, {
      pk: `SITE#${record.siteId}`,
      sk: `${record.ts}#STATE#${record.messageId}`,
      kind: "STATE",
      siteId: record.siteId,
      robotId: record.robotId,
      ts: record.ts,
      messageId: record.messageId,
      from: record.from,
      to: record.to,
      cause: record.cause,
      commandId: record.commandId,
      byRobotPk: `ROBOT#${record.robotId}`,
      byRobotSk: record.ts,
      expiresAt: epochSecondsOf(record.ts) + STATE_RECORD_RETENTION_SECONDS,
    });
  }

  /**
   * Stores one completed mission.
   *
   * @param record - The completed mission.
   * @returns `WRITTEN`, or `DUPLICATE` for a repeated message.
   * @throws On infrastructure errors.
   */
  putMission(record: MissionHistoryRecord): Promise<HistoryWriteOutcome> {
    return putOnce(this.client, this.tableName, {
      pk: `SITE#${record.siteId}`,
      sk: `${record.ts}#MISSION#${record.messageId}`,
      kind: "MISSION",
      siteId: record.siteId,
      robotId: record.robotId,
      ts: record.ts,
      messageId: record.messageId,
      missionId: record.missionId,
      byRobotPk: `ROBOT#${record.robotId}`,
      byRobotSk: record.ts,
      expiresAt: epochSecondsOf(record.ts) + MISSION_RECORD_RETENTION_SECONDS,
    });
  }
}
