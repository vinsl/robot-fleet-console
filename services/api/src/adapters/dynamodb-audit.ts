/**
 * Audit trail over DynamoDB, in the events table: the item of one record, its retention, and the read of one page.
 *
 * Each record is one item keyed by its site and its timestamp, so the trail of a site reads in time order. A second
 * key lists the records of one robot. Every record also carries the status-index keys of the audit partition, so the
 * reader pages the trail through the `openAlerts` index instead of the base partition, which also holds the states
 * and the missions (ADR 0064). Items expire after a year through the table's TTL attribute.
 */
import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  AuditCursorSchema,
  AuditRecordSchema,
  IsoMsSchema,
  SiteIdSchema,
  Uuidv7Schema,
  type AuditCursor,
  type AuditRecord,
  type SiteId,
} from "@mfc/protocol";
import { z } from "zod";
import {
  AuditCursorError,
  type AuditPage,
  type AuditPageRequest,
  type AuditReaderPort,
} from "../domain/audit/ports";
import type { AuditPort } from "../domain/ports";
import { isAwsError } from "./aws-errors";

/** Retention of an audit record, in seconds: one year. */
const AUDIT_RETENTION_SECONDS = 365 * 24 * 60 * 60;

/**
 * Name of the global index that lists the items of a status partition. The alert store owns the same index; the
 * name is repeated here because the alert store imports this module, and importing it back would make a cycle.
 */
const STATUS_INDEX = "openAlerts";

/**
 * Attributes of an audit item that belong to storage, not to the record: the keys, the index keys, the robot index
 * and the TTL. They are dropped before the record is parsed, so the schema, which is strict, sees only the record.
 */
const STORAGE_ONLY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "pk",
  "sk",
  "kind",
  "byRobotPk",
  "byRobotSk",
  "openAlertPk",
  "openAlertSk",
  "expiresAt",
]);

/**
 * Payload of a cursor, before it is encoded: exactly `{siteId, ts, auditId}`.
 *
 * Decision: the payload is strict. The `siteId` must match the site of the request path, and it is checked on the
 * server, because the cursor travels through the client and must not be trusted to name its own partition. The
 * position is the instant and the identifier of the last record, never a storage key, so no DynamoDB key name
 * (`pk`, `sk`, `openAlertPk`, `openAlertSk`) appears in the cursor or the response. An extra attribute makes the
 * cursor invalid rather than ignored, so a tampered payload is refused instead of partly honoured.
 */
const CURSOR_PAYLOAD_SCHEMA = z.strictObject({
  siteId: SiteIdSchema,
  ts: IsoMsSchema,
  auditId: Uuidv7Schema,
});

/**
 * Index sort key of an audit record: `{ts}#{auditId}`. The shape is checked when a key is encoded, so the cursor
 * can only carry a position that the parser accepts.
 */
const INDEX_SORT_KEY_PATTERN = /^([^#]+)#([^#]+)$/;

/**
 * Partition of the `openAlerts` index that holds the audit records of a site.
 *
 * @param siteId - The site.
 * @returns The partition key, `SITE#{siteId}#AUDIT`.
 */
export function auditPartition(siteId: SiteId): string {
  return `SITE#${siteId}#AUDIT`;
}

/**
 * Builds the stored item of an audit record.
 *
 * The expiry is derived from the record's own timestamp, so the item and its retention agree on the same instant
 * without a second clock read. The robot index keys are written only for a robot action: the index is sparse, so a
 * site action is absent from it rather than listed under an empty robot. The status-index keys are written for every
 * record, so the audit trail of a site is one partition of that index. It is exported so that a transaction that
 * carries an audit record (the alert transitions) writes the same item as the standalone write.
 *
 * @param record - The validated audit record.
 * @returns The item, keyed by site and time, with the TTL attribute, the status-index keys and, for a robot action,
 * the robot index.
 */
export function auditItem(record: AuditRecord): Record<string, unknown> {
  const epochSeconds = Math.floor(Date.parse(record.ts) / 1000);
  const robotIndex =
    record.robotId === undefined
      ? {}
      : { byRobotPk: `ROBOT#${record.robotId}`, byRobotSk: record.ts };
  return {
    ...record,
    pk: `SITE#${record.siteId}`,
    sk: `${record.ts}#AUDIT#${record.auditId}`,
    kind: "AUDIT",
    ...robotIndex,
    openAlertPk: auditPartition(record.siteId),
    openAlertSk: `${record.ts}#${record.auditId}`,
    expiresAt: epochSeconds + AUDIT_RETENTION_SECONDS,
  };
}

/**
 * Maps a stored item back to the protocol record: the storage attributes are dropped, and the result is validated
 * by the schema. An item that does not match is reported as null rather than passed on.
 *
 * @param item - The item as read from the events table.
 * @returns The audit record, or null when the item is not an audit record or does not satisfy the schema.
 */
export function auditRecordOf(item: Record<string, unknown>): AuditRecord | null {
  if (item.kind !== "AUDIT") {
    return null;
  }
  const fields = Object.fromEntries(
    Object.entries(item).filter(([name]) => !STORAGE_ONLY_ATTRIBUTES.has(name)),
  );
  const parsed = AuditRecordSchema.safeParse(fields);
  return parsed.success ? parsed.data : null;
}

/**
 * Encodes the position of a page as an opaque cursor: the site, the instant and the identifier of its last record,
 * as base64url JSON. The payload is parsed before it is encoded, so a key that is not an audit position of this site
 * cannot produce a cursor.
 *
 * @param key - The `LastEvaluatedKey` of the query.
 * @param siteId - The site the page was read for.
 * @returns The cursor.
 * @throws Error when the key is outside the audit partition of the site (a contract bug, never a client error).
 */
export function encodeCursor(key: Record<string, unknown>, siteId: SiteId): AuditCursor {
  if (key.openAlertPk !== auditPartition(siteId) || typeof key.openAlertSk !== "string") {
    throw new Error("audit page key outside its partition");
  }
  const match = INDEX_SORT_KEY_PATTERN.exec(key.openAlertSk);
  const payload = CURSOR_PAYLOAD_SCHEMA.parse({
    siteId,
    ts: match?.[1],
    auditId: match?.[2],
  });
  return AuditCursorSchema.parse(
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  );
}

/**
 * Decodes a cursor into the exclusive start key of a query. A cursor issued for another site is refused, and a
 * cursor with an extra attribute, or one that is not JSON, is refused too.
 *
 * Decision: a bad, tampered or foreign cursor is answered `invalid-request` with status 400. The protocol has no
 * invalid-cursor problem type, and the alerts already answer a malformed position the same way, so the client sees
 * one contract for every paged read. The refusal is an `AuditCursorError`, which the domain maps to that problem
 * without echoing the cursor.
 *
 * @param cursor - The cursor sent by the client.
 * @param siteId - The site of the request path, which the cursor must name.
 * @returns The exclusive start key: the table keys and the index keys of the position.
 * @throws AuditCursorError when the cursor is refused.
 */
export function decodeCursor(cursor: AuditCursor, siteId: SiteId): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AuditCursorError();
  }
  const parsed = CURSOR_PAYLOAD_SCHEMA.safeParse(json);
  if (!parsed.success || parsed.data.siteId !== siteId) {
    throw new AuditCursorError();
  }
  const { ts, auditId } = parsed.data;
  return {
    pk: `SITE#${siteId}`,
    sk: `${ts}#AUDIT#${auditId}`,
    openAlertPk: auditPartition(siteId),
    openAlertSk: `${ts}#${auditId}`,
  };
}

/** Writes audit records to the events table. */
export class DynamoDbAudit implements AuditPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The events table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Appends one record. The record is parsed again before it is written: the type says it is valid, but a caller
   * that builds it without the schema must not store a record the contract refuses. The condition makes a repeated
   * write of the same key fail instead of overwriting the earlier record.
   *
   * @param record - The audit record.
   * @throws A zod error when the record does not satisfy the schema, and the SDK error when the write fails; the
   * caller decides what a lost record means.
   */
  async write(record: AuditRecord): Promise<void> {
    const checked = AuditRecordSchema.parse(record);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: auditItem(checked),
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
}

/**
 * Most queries one page may send when a filter is set. DynamoDB applies a filter after it has read the items, so a
 * filtered page can need several queries to fill. The bound keeps the read units and the latency of one request
 * finite; a page that stops early is simply shorter, and the caller pages on from its cursor (ADR 0077).
 */
export const AUDIT_MAX_FILTERED_QUERIES = 5;

/**
 * The filter of one audit query: a filter expression over the item attributes, the names it uses, and the values it
 * compares with. The expression text names only attributes and placeholders, never a value, so a filter value is
 * always passed as an expression value and never as text.
 */
export interface AuditFilter {
  /** The filter expression, absent when no filter is set. */
  readonly FilterExpression?: string;
  /** The attribute name placeholders of the expression, absent when no filter is set. */
  readonly ExpressionAttributeNames?: Record<string, string>;
  /** The expression values, keyed by placeholder. Empty when no filter is set. */
  readonly values: Record<string, string>;
}

/**
 * Builds the filter of an audit page. The two conditions are joined with AND, and each attribute is a name placeholder,
 * so a result or a robot identifier is never read as a reserved word or as expression syntax.
 *
 * @param request - The filters of the page; both are optional.
 * @returns The filter, which has no expression when neither filter is set.
 */
export function auditFilter(request: Pick<AuditPageRequest, "robotId" | "result">): AuditFilter {
  const clauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, string> = {};
  if (request.robotId !== undefined) {
    clauses.push("#robotId = :robotId");
    names["#robotId"] = "robotId";
    values[":robotId"] = request.robotId;
  }
  if (request.result !== undefined) {
    clauses.push("#result = :result");
    names["#result"] = "result";
    values[":result"] = request.result;
  }
  if (clauses.length === 0) {
    return { values };
  }
  return { FilterExpression: clauses.join(" AND "), ExpressionAttributeNames: names, values };
}

/**
 * Reads the audit trail of a site, one page per call, newest first, through the status index. A page may be
 * filtered by robot and by outcome.
 */
export class DynamoDbAuditReader implements AuditReaderPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The events table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * Reads one page. The partition comes from the site of the request, never from the cursor, which only moves the
   * position inside it. Items that do not match the record schema are left out and counted.
   *
   * Without a filter the page is one query, exactly as before. With a filter, the reader keeps querying from the
   * last evaluated key until the page is full, the trail ends, or the query budget is spent. The `Limit` of a query
   * counts the items read before the filter, so each query asks only for the records still missing. The page never
   * holds more records than requested. When the budget is spent, the cursor points after the last item read, so no
   * match is skipped and no record is returned twice.
   *
   * @param request - The site, the page size, the cursor of the page and the filters.
   * @returns The records of the page, the cursor of the next page when there may be one, and the number of stored
   * items that were refused.
   * @throws AuditCursorError when the cursor is refused, by its own checks or by the table.
   */
  async page(request: AuditPageRequest): Promise<AuditPage> {
    const exclusiveStartKey =
      request.cursor === undefined ? undefined : decodeCursor(request.cursor, request.siteId);
    const filter = auditFilter(request);
    const maxQueries = filter.FilterExpression === undefined ? 1 : AUDIT_MAX_FILTERED_QUERIES;

    const items: AuditRecord[] = [];
    let invalidItems = 0;
    let startKey: Record<string, unknown> | undefined = exclusiveStartKey;
    let lastKey: Record<string, unknown> | undefined;
    for (let query = 0; query < maxQueries; query += 1) {
      // Only the first query can start from a cursor the client sent; a later start key comes from the table itself.
      const output = await this.queryPage({
        siteId: request.siteId,
        limit: request.limit - items.length,
        startKey,
        filter,
        fromCursor: query === 0 && request.cursor !== undefined,
      });
      for (const item of output.Items ?? []) {
        const record = auditRecordOf(item);
        if (record === null) {
          invalidItems += 1;
        } else {
          items.push(record);
        }
      }
      lastKey = output.LastEvaluatedKey;
      if (lastKey === undefined || items.length >= request.limit) {
        break;
      }
      startKey = lastKey;
    }

    const nextCursor = lastKey === undefined ? undefined : encodeCursor(lastKey, request.siteId);
    return { items, invalidItems, nextCursor };
  }

  /**
   * Sends one query of the audit partition of the status index.
   *
   * @param query - The site, the number of items to read, the start key, the filter, and whether the start key came
   * from a client cursor.
   * @returns The query output.
   * @throws AuditCursorError when the table rejects a start key that came from a client cursor.
   */
  private async queryPage(query: {
    readonly siteId: SiteId;
    readonly limit: number;
    readonly startKey: Record<string, unknown> | undefined;
    readonly filter: AuditFilter;
    readonly fromCursor: boolean;
  }): Promise<QueryCommandOutput> {
    try {
      return await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: STATUS_INDEX,
          KeyConditionExpression: "openAlertPk = :p",
          ExpressionAttributeValues: { ":p": auditPartition(query.siteId), ...query.filter.values },
          ...(query.filter.FilterExpression === undefined
            ? {}
            : {
                FilterExpression: query.filter.FilterExpression,
                ExpressionAttributeNames: query.filter.ExpressionAttributeNames,
              }),
          ScanIndexForward: false,
          Limit: query.limit,
          ExclusiveStartKey: query.startKey,
        }),
      );
    } catch (error) {
      // The table rejects a start key that does not fit the index. A start key from a decoded cursor is built by the
      // API, so that rejection is the client's malformed cursor, not a failure of the store.
      if (query.fromCursor && isAwsError(error, "ValidationException")) {
        throw new AuditCursorError();
      }
      throw error;
    }
  }
}
