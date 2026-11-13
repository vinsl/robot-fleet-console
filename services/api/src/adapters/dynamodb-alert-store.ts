/**
 * Alert store over DynamoDB: the list of the open and the resolved alerts, the strongly consistent read of one
 * alert, and the two lifecycle transitions. Each transition is one transaction with the audit record, so a
 * transition never happens without its trace.
 *
 * The partitions of every query and key come from the verified site, never from the client: a cursor only
 * carries the position inside the partition, and it is decoded with a strict schema before it is used.
 */
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  AlertCursorSchema,
  AlertRecordSchema,
  type AlertCursor,
  type AlertId,
  type AlertListStatus,
  type AlertRecord,
  type IsoMs,
  type SiteId,
} from "@mfc/protocol";
import { z } from "zod";
import {
  AlertCursorError,
  type AlertListRequest,
  type AlertPage,
  type AlertStorePort,
  type AlertTransition,
  type AlertTransitionOutcome,
} from "../domain/alerts/ports";
import { isAwsError } from "./aws-errors";
import { auditItem } from "./dynamodb-audit";
import {
  alertMarkerSortKey,
  alertSortKey,
  cancellationCodesOf,
  statusPartition,
  type AlertTables,
} from "./dynamodb-alerts";

/** Name of the global index that lists the alerts of a site by status (open, or resolved). */
export const OPEN_ALERTS_INDEX = "openAlerts";

/**
 * Attributes of an alert item that belong to storage, not to the record: the keys, the index keys, the robot
 * index and the TTL. `alertKind` is the stored name of the record's `kind`.
 */
const STORAGE_ONLY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "pk",
  "sk",
  "kind",
  "alertKind",
  "byRobotPk",
  "byRobotSk",
  "openAlertPk",
  "openAlertSk",
  "expiresAt",
]);

/** Sort key of an alert item: `{openedAt}#ALERT#{alertId}`, with the fixed UTC time format. */
const BASE_SORT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#ALERT#[0-9a-f]{32}$/;

/** Index sort key of an open alert: `{severity}#{openedAt}`. */
const ACTIVE_INDEX_KEY_PATTERN =
  /^(CRITICAL|MAJOR|MINOR|INFO)#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Index sort key of a resolved alert: `{resolvedAt}#{alertId}`. */
const RESOLVED_INDEX_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{32}$/;

/** The position of a page inside its status partition. */
interface CursorPayload {
  readonly sk: string;
  readonly gsk: string;
}

/** Payload of an active-list cursor: the base sort key and the severity-first index sort key. */
const ACTIVE_CURSOR_SCHEMA = z.strictObject({
  sk: z.string().regex(BASE_SORT_KEY_PATTERN),
  gsk: z.string().regex(ACTIVE_INDEX_KEY_PATTERN),
});

/** Payload of a resolved-list cursor: the base sort key and the time-first index sort key. */
const RESOLVED_CURSOR_SCHEMA = z.strictObject({
  sk: z.string().regex(BASE_SORT_KEY_PATTERN),
  gsk: z.string().regex(RESOLVED_INDEX_KEY_PATTERN),
});

/**
 * The payload schema of a cursor. The index sort key differs by status, so each list has its own schema.
 *
 * @param status - The list status of the request.
 * @returns The schema of the cursor payload of that status.
 */
function cursorSchemaOf(status: AlertListStatus): z.ZodType<CursorPayload> {
  return status === "active" ? ACTIVE_CURSOR_SCHEMA : RESOLVED_CURSOR_SCHEMA;
}

/** One item of a transaction. */
type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/**
 * Maps a stored item back to the protocol record: the storage attributes are dropped and the stored alert kind
 * takes back its record name. The result is validated by the schema, so an item that does not match is reported
 * as null rather than passed on.
 *
 * @param item - The item as read from the events table.
 * @returns The alert record, or null when the item is not an alert or does not satisfy the schema.
 */
export function alertRecordOf(item: Record<string, unknown>): AlertRecord | null {
  if (item.kind !== "ALERT") {
    return null;
  }
  const fields = Object.fromEntries(
    Object.entries(item).filter(([name]) => !STORAGE_ONLY_ATTRIBUTES.has(name)),
  );
  const parsed = AlertRecordSchema.safeParse({ ...fields, kind: item.alertKind });
  return parsed.success ? parsed.data : null;
}

/**
 * Maps a list status to the status of the stored alert.
 *
 * @param status - The list status of the request.
 * @returns `OPEN` for the active list, `RESOLVED` for the history.
 */
function storedStatusOf(status: AlertListStatus): "OPEN" | "RESOLVED" {
  return status === "active" ? "OPEN" : "RESOLVED";
}

/**
 * Encodes the position of a page as an opaque cursor: the base sort key and the index sort key of the last item,
 * as base64url JSON. The payload is parsed before it is encoded, so a page that does not carry the expected keys
 * cannot produce a cursor.
 *
 * @param key - The `LastEvaluatedKey` of the query.
 * @param status - The list status the page belongs to.
 * @returns The cursor.
 * @throws A zod error when the key does not carry the expected attributes (a contract bug, never a client error).
 */
export function encodeCursor(key: Record<string, unknown>, status: AlertListStatus): AlertCursor {
  const payload = cursorSchemaOf(status).parse({ sk: key.sk, gsk: key.openAlertSk });
  return AlertCursorSchema.parse(
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  );
}

/**
 * Decodes a cursor into the exclusive start key of a query. The partitions are built from the verified site and the
 * requested status, so a cursor can only move the position inside the partition it was issued for.
 *
 * @param cursor - The cursor sent by the client.
 * @param siteId - The site of the verified principal.
 * @param status - The list status of the request.
 * @returns The exclusive start key, with the base and index keys.
 * @throws AlertCursorError when the cursor is not the payload of this status, or is not JSON.
 */
export function decodeCursor(
  cursor: AlertCursor,
  siteId: SiteId,
  status: AlertListStatus,
): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AlertCursorError();
  }
  const parsed = cursorSchemaOf(status).safeParse(json);
  if (!parsed.success) {
    throw new AlertCursorError();
  }
  return {
    pk: `SITE#${siteId}`,
    sk: parsed.data.sk,
    openAlertPk: statusPartition(siteId, storedStatusOf(status)),
    openAlertSk: parsed.data.gsk,
  };
}

/**
 * The key of an alert item in the events table.
 *
 * @param alert - The alert.
 * @returns The partition and sort key.
 */
function alertKeyOf(alert: AlertRecord): Record<string, string> {
  return { pk: `SITE#${alert.siteId}`, sk: alertSortKey(alert.openedAt, alert.alertId) };
}

/**
 * Returns a field the domain guarantees for an alert in the target status. A missing field is a contract bug, so
 * it is reported as an error rather than written as an empty value.
 *
 * @param value - The field of the record.
 * @param field - The field name, for the error message.
 * @returns The value.
 * @throws Error when the field is absent.
 */
function requiredField<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(`alert transition without ${field}`);
  }
  return value;
}

/**
 * Tells whether a transaction was cancelled because the condition of one item failed.
 *
 * @param error - The rejection of the transaction.
 * @param index - The position of the item in the transaction.
 * @returns True when that item's condition failed.
 */
function conditionFailedAt(error: unknown, index: number): boolean {
  return (
    isAwsError(error, "TransactionCanceledException") &&
    cancellationCodesOf(error).at(index) === "ConditionalCheckFailed"
  );
}

/**
 * Alert store over the events and fleet tables.
 */
export class DynamoDbAlertStore implements AlertStorePort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tables - The events table (alerts and audit) and the fleet table (markers).
   * @param onMarkerMismatch - Called when a resolution finds the marker of its robot naming another alert. This
   * cannot happen by construction; it is counted so that an impossible state is visible.
   * @param onCursorRejected - Called when the table rejects a reused cursor, which is the client's malformed input.
   * It is counted so that a burst of rejected cursors is visible without logging the cursor itself.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tables: AlertTables,
    private readonly onMarkerMismatch: () => void = () => undefined,
    private readonly onCursorRejected: () => void = () => undefined,
  ) {}

  /**
   * Lists one page of the active or the resolved alerts of a site. The history is newest first, by resolution time.
   * The active list is ordered by its index key `SEVERITY#openedAt` as a plain string, so the order is alphabetical
   * (CRITICAL, INFO, MAJOR, MINOR), not severity order, and the time order holds only inside one severity. Clients
   * must sort the pages they merge. `since` is read only for the resolved history: the active list ignores it, and
   * the query schema refuses it on that status before the store is reached.
   *
   * One query per call: `Limit` applies before the filter, so a page can be short or empty while a cursor is still
   * returned; the caller follows the cursor.
   *
   * @param request - The site, the status, the filters, the page size and the cursor of the page.
   * @returns The alerts of the page, the cursor of the next page and the number of stored items that were refused.
   * @throws AlertCursorError when the cursor is not valid for this site and status.
   */
  async list(request: AlertListRequest): Promise<AlertPage> {
    const exclusiveStartKey =
      request.cursor === undefined
        ? undefined
        : decodeCursor(request.cursor, request.siteId, request.status);
    const values: Record<string, string> = {
      ":p": statusPartition(request.siteId, storedStatusOf(request.status)),
    };
    let keyCondition = "openAlertPk = :p";
    const filters: string[] = [];
    if (request.status === "active") {
      if (request.severity !== undefined) {
        keyCondition += " AND begins_with(openAlertSk, :severityPrefix)";
        values[":severityPrefix"] = `${request.severity}#`;
      }
    } else {
      if (request.since !== undefined) {
        keyCondition += " AND openAlertSk >= :since";
        values[":since"] = request.since;
      }
      if (request.severity !== undefined) {
        filters.push("severity = :severity");
        values[":severity"] = request.severity;
      }
    }
    if (request.robotId !== undefined) {
      filters.push("robotId = :robotId");
      values[":robotId"] = request.robotId;
    }

    let output: QueryCommandOutput;
    try {
      output = await this.client.send(
        new QueryCommand({
          TableName: this.tables.eventsTable,
          IndexName: OPEN_ALERTS_INDEX,
          KeyConditionExpression: keyCondition,
          ...(filters.length > 0 ? { FilterExpression: filters.join(" AND ") } : {}),
          ExpressionAttributeValues: values,
          ScanIndexForward: request.status === "active",
          Limit: request.limit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (error) {
      // DynamoDB rejects a start key that does not fit the index keys. Only a cursor can make the start key, so
      // that rejection is the client's malformed cursor, not a failure of the store.
      if (request.cursor !== undefined && isAwsError(error, "ValidationException")) {
        this.onCursorRejected();
        throw new AlertCursorError();
      }
      throw error;
    }

    const alerts: AlertRecord[] = [];
    let invalidItems = 0;
    for (const item of output.Items ?? []) {
      const alert = alertRecordOf(item);
      if (alert === null) {
        invalidItems += 1;
      } else {
        alerts.push(alert);
      }
    }
    const nextCursor =
      output.LastEvaluatedKey === undefined
        ? undefined
        : encodeCursor(output.LastEvaluatedKey, request.status);
    return { alerts, nextCursor, invalidItems };
  }

  /**
   * Reads one alert by its key with a strongly consistent read, so an alert opened a moment ago is found.
   *
   * @param siteId - The site of the verified principal.
   * @param alertId - The alert identifier of the path.
   * @param openedAt - The opening time of the alert, from the request body.
   * @returns The alert, or null when no item has this key or the item is not a valid alert of this identifier.
   */
  async get(siteId: SiteId, alertId: AlertId, openedAt: IsoMs): Promise<AlertRecord | null> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tables.eventsTable,
        Key: { pk: `SITE#${siteId}`, sk: alertSortKey(openedAt, alertId) },
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) {
      return null;
    }
    const alert = alertRecordOf(output.Item);
    return alert !== null && alert.alertId === alertId ? alert : null;
  }

  /**
   * Acknowledges an open alert: the alert moves to ACKNOWLEDGED with the actor and the time, and its audit record
   * is written in the same transaction. The client token is the audit identifier, so an SDK retry of a committed
   * transaction succeeds instead of failing on its own write.
   *
   * @param transition - The alert before and after the change, and its audit record.
   * @returns `APPLIED`, or `CONFLICT` when the alert is no longer OPEN.
   * @throws On any other failure of the transaction.
   */
  async acknowledge(transition: AlertTransition): Promise<AlertTransitionOutcome> {
    const { next, audit } = transition;
    const acknowledgedBy = requiredField(next.acknowledgedBy, "acknowledgedBy");
    const acknowledgedAt = requiredField(next.acknowledgedAt, "acknowledgedAt");
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: audit.auditId,
          TransactItems: [
            {
              Update: {
                TableName: this.tables.eventsTable,
                Key: alertKeyOf(next),
                UpdateExpression: "SET #status = :ack, acknowledgedBy = :by, acknowledgedAt = :at",
                ConditionExpression: "#status = :open AND alertId = :id",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":ack": "ACKNOWLEDGED",
                  ":open": "OPEN",
                  ":id": next.alertId,
                  ":by": acknowledgedBy,
                  ":at": acknowledgedAt,
                },
              },
            },
            {
              Put: {
                TableName: this.tables.eventsTable,
                Item: auditItem(audit),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return "APPLIED";
    } catch (error) {
      if (conditionFailedAt(error, 0)) {
        return "CONFLICT";
      }
      throw error;
    }
  }

  /**
   * Resolves an acknowledged alert: the alert moves to RESOLVED and into the resolved partition of the index, its
   * robot's open-alert marker is deleted, and its audit record is written, all in one transaction. The marker is
   * deleted only when it names this alert; if it names another one (impossible by construction), the marker is
   * left alone, the callback is called and the alert and its audit record are still committed.
   *
   * @param transition - The alert before and after the change, and its audit record.
   * @returns `APPLIED`, or `CONFLICT` when the alert is no longer ACKNOWLEDGED.
   * @throws On any other failure of a transaction.
   */
  async resolve(transition: AlertTransition): Promise<AlertTransitionOutcome> {
    const { next, audit } = transition;
    const resolvedBy = requiredField(next.resolvedBy, "resolvedBy");
    const resolvedAt = requiredField(next.resolvedAt, "resolvedAt");
    const alertUpdate: TransactItem = {
      Update: {
        TableName: this.tables.eventsTable,
        Key: alertKeyOf(next),
        UpdateExpression:
          "SET #status = :resolved, resolvedBy = :by, resolvedAt = :at, openAlertPk = :rp, openAlertSk = :rs",
        ConditionExpression: "#status = :acked AND alertId = :id",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":resolved": "RESOLVED",
          ":acked": "ACKNOWLEDGED",
          ":id": next.alertId,
          ":by": resolvedBy,
          ":at": resolvedAt,
          ":rp": statusPartition(next.siteId, "RESOLVED"),
          ":rs": `${resolvedAt}#${next.alertId}`,
        },
      },
    };
    const auditPut: TransactItem = {
      Put: {
        TableName: this.tables.eventsTable,
        Item: auditItem(audit),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    };
    const markerDelete: TransactItem = {
      Delete: {
        TableName: this.tables.fleetTable,
        Key: { pk: `SITE#${next.siteId}`, sk: alertMarkerSortKey(next.robotId, next.kind) },
        ConditionExpression: "attribute_not_exists(pk) OR alertId = :id",
        ExpressionAttributeValues: { ":id": next.alertId },
      },
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: audit.auditId,
          TransactItems: [alertUpdate, markerDelete, auditPut],
        }),
      );
      return "APPLIED";
    } catch (error) {
      if (conditionFailedAt(error, 0)) {
        return "CONFLICT";
      }
      if (!conditionFailedAt(error, 1)) {
        throw error;
      }
    }

    // The marker names another alert. The alert transition still has to happen, without touching that marker.
    this.onMarkerMismatch();
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [alertUpdate, auditPut] }));
      return "APPLIED";
    } catch (error) {
      if (conditionFailedAt(error, 0)) {
        return "CONFLICT";
      }
      throw error;
    }
  }
}
