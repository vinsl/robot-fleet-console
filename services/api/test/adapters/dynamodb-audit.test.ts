/**
 * Audit adapter over DynamoDB: the item written for one record, its keys and its retention, and the read of one page
 * through the status index, with the cursor checks.
 */
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AuditRecordSchema, type AuditCursor, type AuditRecord } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  auditFilter,
  auditItem,
  AUDIT_MAX_FILTERED_QUERIES,
  decodeCursor,
  DynamoDbAudit,
  DynamoDbAuditReader,
  encodeCursor,
} from "../../src/adapters/dynamodb-audit";
import { AuditCursorError } from "../../src/domain/audit/ports";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const TABLE = "mfc-demo-events";
const TS = "2026-11-02T10:00:00.000Z";
const AUDIT_ID = "0190a0a0-0000-7000-8000-000000000001";
const LATER_TS = "2026-11-02T10:05:00.000Z";
const LATER_AUDIT_ID = "0190a0a0-0000-7000-8000-000000000009";
const SITE = "paris-01";

/** One validated audit record of a successful registration. */
const RECORD: AuditRecord = AuditRecordSchema.parse({
  auditId: AUDIT_ID,
  ts: TS,
  siteId: SITE,
  robotId: "kali-01",
  actor: "vincent",
  actorSource: "mfc.admin",
  action: "robots.register",
  result: "SUCCEEDED",
  correlationId: "corr-00000001",
});

/** A later site action, without a robot, so the sparse robot index does not apply to it. */
const SITE_RECORD: AuditRecord = AuditRecordSchema.parse({
  auditId: LATER_AUDIT_ID,
  ts: LATER_TS,
  siteId: SITE,
  actor: "vincent",
  actorSource: "mfc.jwt",
  action: "site.map.activate",
  result: "SUCCEEDED",
  mapVersion: 3,
  correlationId: "corr-00000002",
});

/**
 * The key an index query returns for the last item of a page: the table keys and the index keys.
 *
 * @param record - The record of the item.
 * @returns The last evaluated key.
 */
function keyOf(record: AuditRecord): Record<string, string> {
  return {
    pk: `SITE#${record.siteId}`,
    sk: `${record.ts}#AUDIT#${record.auditId}`,
    openAlertPk: `SITE#${record.siteId}#AUDIT`,
    openAlertSk: `${record.ts}#${record.auditId}`,
  };
}

/**
 * Encodes a payload as a cursor, bypassing the encoder, to build tampered cursors for the refusal tests.
 *
 * @param payload - The JSON payload.
 * @returns The cursor text.
 */
function rawCursor(payload: unknown): AuditCursor {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("DynamoDbAudit.write", () => {
  it("writes the record keyed by site and time, with the robot index, the status index and a one-year expiry", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const audit = new DynamoDbAudit(documentClientStub(send), TABLE);

    await audit.write(RECORD);

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(PutCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          pk: "SITE#paris-01",
          sk: `${TS}#AUDIT#${AUDIT_ID}`,
          kind: "AUDIT",
          byRobotPk: "ROBOT#kali-01",
          byRobotSk: TS,
          openAlertPk: "SITE#paris-01#AUDIT",
          openAlertSk: `${TS}#${AUDIT_ID}`,
          expiresAt: Date.parse(TS) / 1000 + 365 * 24 * 60 * 60,
          auditId: AUDIT_ID,
          actor: "vincent",
          result: "SUCCEEDED",
        },
      },
    });
  });

  it("writes a site action without any robot index key, so the sparse index omits it", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const audit = new DynamoDbAudit(documentClientStub(send), TABLE);
    const siteRecord: AuditRecord = AuditRecordSchema.parse({
      auditId: AUDIT_ID,
      ts: TS,
      siteId: "paris-01",
      actor: "vincent",
      actorSource: "mfc.jwt",
      action: "site.map.activate",
      result: "SUCCEEDED",
      mapVersion: 3,
      correlationId: "corr-00000002",
    });

    await audit.write(siteRecord);

    const [command] = sentCommands(send);
    expect(command).toMatchObject({
      input: {
        Item: {
          pk: "SITE#paris-01",
          mapVersion: 3,
          action: "site.map.activate",
        },
      },
    });
    const item = (command as PutCommand).input.Item;
    expect(item).not.toHaveProperty("byRobotPk");
    expect(item).not.toHaveProperty("byRobotSk");
    expect(item).toMatchObject({
      openAlertPk: "SITE#paris-01#AUDIT",
      openAlertSk: `${TS}#${AUDIT_ID}`,
    });
  });

  it("rethrows a failed write so that the caller can decide what a lost record means", async () => {
    const send = sendStub();
    const failure = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(failure);
    const audit = new DynamoDbAudit(documentClientStub(send), TABLE);

    await expect(audit.write(RECORD)).rejects.toBe(failure);
  });

  it("refuses to write a record the schema rejects, and sends nothing", async () => {
    const send = sendStub();
    const audit = new DynamoDbAudit(documentClientStub(send), TABLE);
    // A record built without the schema: a site action that names a robot, which the schema refuses.
    const malformed = {
      ...RECORD,
      action: "site.update",
      result: "SUCCEEDED",
    } as unknown as AuditRecord;

    await expect(audit.write(malformed)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("auditItem", () => {
  it("keys every record, site actions included, in the audit partition of the status index", () => {
    expect(auditItem(SITE_RECORD)).toMatchObject({
      openAlertPk: "SITE#paris-01#AUDIT",
      openAlertSk: `${LATER_TS}#${LATER_AUDIT_ID}`,
    });
  });
});

describe("DynamoDbAuditReader.page", () => {
  it("queries the status index of the audit partition, newest first, with the page size", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [] });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await reader.page({ siteId: SITE, limit: 50 });

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(QueryCommand);
    expect((command as QueryCommand).input).toEqual({
      TableName: TABLE,
      IndexName: "openAlerts",
      KeyConditionExpression: "openAlertPk = :p",
      ExpressionAttributeValues: { ":p": "SITE#paris-01#AUDIT" },
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: undefined,
    });
  });

  it("returns the records of the page without any storage attribute", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [auditItem(SITE_RECORD), auditItem(RECORD)],
    });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 50 });

    expect(page).toEqual({ items: [SITE_RECORD, RECORD], invalidItems: 0, nextCursor: undefined });
  });

  it("leaves out and counts a stored item that does not match the record schema, and any non-audit item", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [
        { ...auditItem(RECORD), actor: "" },
        { ...auditItem(RECORD), kind: "ALERT" },
        auditItem(SITE_RECORD),
      ],
    });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 50 });

    expect(page.items).toEqual([SITE_RECORD]);
    expect(page.invalidItems).toBe(2);
  });

  it("returns a cursor that names the position and no storage key name, and round-trips into the next query", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [auditItem(RECORD)], LastEvaluatedKey: keyOf(RECORD) });
    send.mockResolvedValueOnce({ Items: [] });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const first = await reader.page({ siteId: SITE, limit: 1 });

    expect(first.nextCursor).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(first.nextCursor ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["auditId", "siteId", "ts"]);
    expect(payload).toEqual({ siteId: SITE, ts: TS, auditId: AUDIT_ID });

    await reader.page({ siteId: SITE, limit: 1, cursor: first.nextCursor });

    expect((sentCommands(send)[1] as QueryCommand).input.ExclusiveStartKey).toEqual(keyOf(RECORD));
  });

  it("never leaks a DynamoDB key name into the cursor or the response", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [auditItem(RECORD)], LastEvaluatedKey: keyOf(RECORD) });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 1 });
    const cursorText = Buffer.from(page.nextCursor ?? "", "base64url").toString("utf8");
    const responseText = JSON.stringify(page.items);

    for (const text of [cursorText, responseText]) {
      expect(text).not.toMatch(/openAlert|"pk"|"sk"|expiresAt|byRobot|"kind"/);
      expect(text).not.toContain("SITE#");
    }
  });

  it("refuses a cursor issued for another site, before any query", async () => {
    const send = sendStub();
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);
    const cursor = encodeCursor(keyOf(RECORD), SITE);

    await expect(reader.page({ siteId: "other-site", limit: 50, cursor })).rejects.toThrow(
      AuditCursorError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a cursor the table rejects as a validation error", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ValidationException"));
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await expect(
      reader.page({ siteId: SITE, limit: 50, cursor: encodeCursor(keyOf(RECORD), SITE) }),
    ).rejects.toThrow(AuditCursorError);
  });

  it("rethrows any other store failure, and does not call it a cursor refusal", async () => {
    const send = sendStub();
    const failure = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(failure);
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await expect(reader.page({ siteId: SITE, limit: 50 })).rejects.toBe(failure);
  });
});

describe("auditFilter", () => {
  it("builds no expression when no filter is set", () => {
    expect(auditFilter({})).toEqual({ values: {} });
  });

  it("joins the robot and the outcome with AND, and names every attribute by a placeholder", () => {
    expect(auditFilter({ robotId: "kali-01", result: "REFUSED" })).toEqual({
      FilterExpression: "#robotId = :robotId AND #result = :result",
      ExpressionAttributeNames: { "#robotId": "robotId", "#result": "result" },
      values: { ":robotId": "kali-01", ":result": "REFUSED" },
    });
  });
});

describe("DynamoDbAuditReader.page with filters", () => {
  /** A second record of the robot of RECORD, older than it, so both match the robot filter. */
  const OLDER: AuditRecord = AuditRecordSchema.parse({
    ...RECORD,
    auditId: "0190a0a0-0000-7000-8000-000000000005",
    ts: "2026-11-02T09:00:00.000Z",
  });

  it("sends no filter attribute when no filter is set, and one query only", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [auditItem(RECORD)], LastEvaluatedKey: keyOf(RECORD) });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 1 });

    expect(send).toHaveBeenCalledTimes(1);
    const input = (sentCommands(send)[0] as QueryCommand).input;
    expect(input).not.toHaveProperty("FilterExpression");
    expect(input).not.toHaveProperty("ExpressionAttributeNames");
    expect(input.ExpressionAttributeValues).toEqual({ ":p": "SITE#paris-01#AUDIT" });
    expect(input.Limit).toBe(1);
    expect(page.nextCursor).toBeDefined();
  });

  it("sends both filters as expression values and attribute names, never as expression text", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [] });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await reader.page({ siteId: SITE, limit: 50, robotId: "kali-01", result: "REFUSED" });

    expect((sentCommands(send)[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "openAlertPk = :p",
      FilterExpression: "#robotId = :robotId AND #result = :result",
      ExpressionAttributeNames: { "#robotId": "robotId", "#result": "result" },
      ExpressionAttributeValues: {
        ":p": "SITE#paris-01#AUDIT",
        ":robotId": "kali-01",
        ":result": "REFUSED",
      },
    });
  });

  it("keeps querying from the last evaluated key until a filtered page is full", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: keyOf(SITE_RECORD) });
    send.mockResolvedValueOnce({
      Items: [auditItem(RECORD), auditItem(OLDER)],
      LastEvaluatedKey: keyOf(OLDER),
    });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 2, robotId: "kali-01" });

    expect(page.items).toEqual([RECORD, OLDER]);
    expect(page.nextCursor).toBeDefined();
    expect(decodeCursor(page.nextCursor ?? "", SITE)).toEqual(keyOf(OLDER));
    expect(send).toHaveBeenCalledTimes(2);
    expect((sentCommands(send)[1] as QueryCommand).input.ExclusiveStartKey).toEqual(
      keyOf(SITE_RECORD),
    );
  });

  it("asks the second query only for the records still missing", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [auditItem(RECORD)], LastEvaluatedKey: keyOf(RECORD) });
    send.mockResolvedValueOnce({ Items: [] });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 3, robotId: "kali-01" });

    expect(page.items).toEqual([RECORD]);
    expect(page.nextCursor).toBeUndefined();
    expect((sentCommands(send)[0] as QueryCommand).input.Limit).toBe(3);
    expect((sentCommands(send)[1] as QueryCommand).input.Limit).toBe(2);
  });

  it("stops after the query budget, with a cursor that keeps the rest of the trail reachable", async () => {
    const send = sendStub();
    for (let query = 0; query < AUDIT_MAX_FILTERED_QUERIES; query += 1) {
      send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: keyOf(SITE_RECORD) });
    }
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 10, result: "FAILED" });

    expect(send).toHaveBeenCalledTimes(AUDIT_MAX_FILTERED_QUERIES);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe(encodeCursor(keyOf(SITE_RECORD), SITE));
  });

  it("never returns more records than the limit, even when more match later in the trail", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [auditItem(RECORD), auditItem(OLDER)],
      LastEvaluatedKey: keyOf(OLDER),
    });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 2, robotId: "kali-01" });

    expect(page.items).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("counts the stored items left out across all the queries of one page", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [{ ...auditItem(RECORD), actor: "" }],
      LastEvaluatedKey: keyOf(RECORD),
    });
    send.mockResolvedValueOnce({ Items: [auditItem(OLDER)] });
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    const page = await reader.page({ siteId: SITE, limit: 2, robotId: "kali-01" });

    expect(page.items).toEqual([OLDER]);
    expect(page.invalidItems).toBe(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it("refuses a cursor the table rejects, when the filter is applied from it", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ValidationException"));
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await expect(
      reader.page({
        siteId: SITE,
        limit: 50,
        cursor: encodeCursor(keyOf(RECORD), SITE),
        robotId: "kali-01",
      }),
    ).rejects.toThrow(AuditCursorError);
  });

  it("rethrows a validation error from a later query, which is not the client's cursor", async () => {
    const send = sendStub();
    const failure = awsError("ValidationException");
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: keyOf(RECORD) });
    send.mockRejectedValueOnce(failure);
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);

    await expect(reader.page({ siteId: SITE, limit: 2, result: "REFUSED" })).rejects.toBe(failure);
  });

  it("refuses a tampered cursor before any query, even with a filter set", async () => {
    const send = sendStub();
    const reader = new DynamoDbAuditReader(documentClientStub(send), TABLE);
    const cursor = rawCursor({ siteId: SITE, ts: TS, auditId: AUDIT_ID, pk: `SITE#${SITE}` });

    await expect(
      reader.page({ siteId: SITE, limit: 50, cursor, robotId: "kali-01" }),
    ).rejects.toThrow(AuditCursorError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("audit cursors", () => {
  it("round-trips the position of a record of the site", () => {
    const cursor = encodeCursor(keyOf(RECORD), SITE);

    expect(decodeCursor(cursor, SITE)).toEqual(keyOf(RECORD));
  });

  it("refuses to encode a key outside the audit partition of the site", () => {
    const alertKey = { ...keyOf(RECORD), openAlertPk: "SITE#paris-01#OPEN" };

    expect(() => encodeCursor(alertKey, SITE)).toThrow();
    expect(() => encodeCursor(keyOf(RECORD), "other-site")).toThrow();
  });

  it("refuses to encode a key whose index sort key is not a timestamp and an identifier", () => {
    const broken = { ...keyOf(RECORD), openAlertSk: `${TS}#${AUDIT_ID}#extra` };

    expect(() => encodeCursor(broken, SITE)).toThrow();
  });

  it("refuses a cursor that is not base64url JSON", () => {
    const cursor = rawCursor("not an object");
    const notJson = Buffer.from("{not json", "utf8").toString("base64url");

    expect(() => decodeCursor(cursor, SITE)).toThrow(AuditCursorError);
    expect(() => decodeCursor(notJson, SITE)).toThrow(AuditCursorError);
  });

  it("refuses a cursor that carries an extra attribute, such as a storage key", () => {
    const cursor = rawCursor({
      siteId: SITE,
      ts: TS,
      auditId: AUDIT_ID,
      pk: `SITE#${SITE}`,
    });

    expect(() => decodeCursor(cursor, SITE)).toThrow(AuditCursorError);
  });

  it("refuses a cursor whose timestamp or identifier is malformed", () => {
    const badTs = rawCursor({ siteId: SITE, ts: "yesterday", auditId: AUDIT_ID });
    const badId = rawCursor({ siteId: SITE, ts: TS, auditId: "not-a-uuid" });

    expect(() => decodeCursor(badTs, SITE)).toThrow(AuditCursorError);
    expect(() => decodeCursor(badId, SITE)).toThrow(AuditCursorError);
  });

  it("refuses a cursor that names another site, even when its position is valid", () => {
    const cursor = rawCursor({ siteId: "other-site", ts: TS, auditId: AUDIT_ID });

    expect(() => decodeCursor(cursor, SITE)).toThrow(AuditCursorError);
  });
});
