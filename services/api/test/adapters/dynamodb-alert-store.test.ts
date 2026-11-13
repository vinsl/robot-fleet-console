/**
 * Alert store over DynamoDB: the list queries and their cursors, the consistent read, and the two transitions with
 * their transactions, conditions and cancellation reasons.
 */
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AlertCursorSchema,
  AlertRecordSchema,
  AuditRecordSchema,
  type AlertRecord,
  type AuditRecord,
} from "@mfc/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbAlertStore,
  alertRecordOf,
  decodeCursor,
  encodeCursor,
} from "../../src/adapters/dynamodb-alert-store";
import { DynamoDbAlerts } from "../../src/adapters/dynamodb-alerts";
import { AlertCursorError, type AlertTransition } from "../../src/domain/alerts/ports";
import { openAlertRecord } from "../../src/domain/live/alerts";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands, type SendMock } from "../fakes/sdk-stub";

const EVENTS = "mfc-demo-events";
const FLEET = "mfc-demo-fleet";
const TABLES = { eventsTable: EVENTS, fleetTable: FLEET };
const SITE = "paris-01";
const ACTOR = "00000000-0000-4000-8000-000000000001";
const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";
const OPENED_AT = "2026-11-02T10:00:00.000Z";
const ACKNOWLEDGED_AT = "2026-11-02T10:05:00.000Z";
const RESOLVED_AT = "2026-11-02T10:09:00.000Z";
const ACK_AUDIT_ID = "0190a0a0-0000-7000-8000-00000000000a";
const RESOLVE_AUDIT_ID = "0190a0a0-0000-7000-8000-00000000000b";

/** An open BLOCKED alert (MAJOR), built by the domain. */
const OPEN_ALERT: AlertRecord = openAlertRecord({
  siteId: SITE,
  robotId: "kali-01",
  kind: "BLOCKED",
  sourceKey: MESSAGE,
  sourceMessageId: MESSAGE,
  openedAt: OPENED_AT,
  cause: "OBSTACLE_DETECTED",
});

/** The same alert, acknowledged. */
const ACKNOWLEDGED_ALERT: AlertRecord = AlertRecordSchema.parse({
  ...OPEN_ALERT,
  status: "ACKNOWLEDGED",
  acknowledgedBy: ACTOR,
  acknowledgedAt: ACKNOWLEDGED_AT,
});

/** The same alert, resolved after its acknowledgement. */
const RESOLVED_ALERT: AlertRecord = AlertRecordSchema.parse({
  ...ACKNOWLEDGED_ALERT,
  status: "RESOLVED",
  resolvedBy: ACTOR,
  resolvedAt: RESOLVED_AT,
});

/**
 * The audit record of one alert transition.
 *
 * @param auditId - The audit identifier.
 * @param ts - The time of the transition.
 * @param action - The alert action.
 * @returns The validated record.
 */
function auditOf(
  auditId: string,
  ts: string,
  action: "alert.acknowledge" | "alert.resolve",
): AuditRecord {
  return AuditRecordSchema.parse({
    auditId,
    ts,
    siteId: SITE,
    robotId: "kali-01",
    alertId: OPEN_ALERT.alertId,
    actor: ACTOR,
    actorSource: "mfc.jwt",
    action,
    result: "SUCCEEDED",
    correlationId: "corr-00000010",
  });
}

const ACK_AUDIT = auditOf(ACK_AUDIT_ID, ACKNOWLEDGED_AT, "alert.acknowledge");
const RESOLVE_AUDIT = auditOf(RESOLVE_AUDIT_ID, RESOLVED_AT, "alert.resolve");

/**
 * A transaction cancellation with one reason per item, as the SDK raises it.
 *
 * @param codes - The reason code of each item, in the order of the transaction.
 * @returns The error.
 */
function cancelled(...codes: string[]): Error {
  return Object.assign(awsError("TransactionCanceledException"), {
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

/**
 * The item the open transaction stores for an alert, as the domain writer builds it.
 *
 * @param alert - The alert.
 * @returns The stored item.
 */
async function storedItemOf(alert: AlertRecord): Promise<Record<string, unknown>> {
  const send = sendStub();
  send.mockResolvedValueOnce({});
  await new DynamoDbAlerts(documentClientStub(send), TABLES).open(alert);
  const command = sentCommands(send)[0];
  expect(command).toBeInstanceOf(TransactWriteCommand);
  const item = (command as TransactWriteCommand).input.TransactItems?.[0]?.Put?.Item;
  if (item === undefined) {
    throw new Error("the open transaction carries no alert item");
  }
  return item;
}

/**
 * A store over a scripted client.
 *
 * @param send - The mock of the client.
 * @param onMarkerMismatch - The callback of the store.
 * @returns The store.
 */
function storeOver(
  send: SendMock,
  onMarkerMismatch?: () => void,
  onCursorRejected?: () => void,
): DynamoDbAlertStore {
  return new DynamoDbAlertStore(
    documentClientStub(send),
    TABLES,
    onMarkerMismatch,
    onCursorRejected,
  );
}

describe("alertRecordOf", () => {
  it("maps a stored alert back to the record it was written from", async () => {
    const item = await storedItemOf(OPEN_ALERT);

    expect(alertRecordOf(item)).toEqual(OPEN_ALERT);
  });

  it("returns null for an item that is not an alert", () => {
    expect(alertRecordOf({ pk: `SITE#${SITE}`, kind: "AUDIT", auditId: ACK_AUDIT_ID })).toBeNull();
  });

  it("returns null for a stored alert whose severity does not match its kind", async () => {
    const item = await storedItemOf(OPEN_ALERT);

    expect(alertRecordOf({ ...item, severity: "INFO" })).toBeNull();
  });
});

describe("DynamoDbAlertStore.list", () => {
  it("queries the active partition of the status index by severity, with the robot filter and the page size", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [await storedItemOf(OPEN_ALERT)] });
    const store = storeOver(send);

    const page = await store.list({
      siteId: SITE,
      status: "active",
      severity: "MAJOR",
      robotId: "kali-01",
      limit: 20,
    });

    const input = (sentCommands(send)[0] as QueryCommand).input;
    expect(input).toMatchObject({
      TableName: EVENTS,
      IndexName: "openAlerts",
      KeyConditionExpression: "openAlertPk = :p AND begins_with(openAlertSk, :severityPrefix)",
      FilterExpression: "robotId = :robotId",
      ExpressionAttributeValues: {
        ":p": "SITE#paris-01#OPEN",
        ":severityPrefix": "MAJOR#",
        ":robotId": "kali-01",
      },
      ScanIndexForward: true,
      Limit: 20,
    });
    expect(input.ExclusiveStartKey).toBeUndefined();
    expect(page.alerts).toEqual([OPEN_ALERT]);
    expect(page.invalidItems).toBe(0);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns a cursor when the query has more items, and the cursor resumes the same partition", async () => {
    const lastKey = {
      pk: `SITE#${SITE}`,
      sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
      openAlertPk: "SITE#paris-01#OPEN",
      openAlertSk: `MAJOR#${OPENED_AT}`,
    };
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [await storedItemOf(OPEN_ALERT)],
      LastEvaluatedKey: lastKey,
    });
    const store = storeOver(send);

    const page = await store.list({ siteId: SITE, status: "active", limit: 1 });

    const cursor = page.nextCursor;
    if (cursor === undefined) {
      throw new Error("the page with a last evaluated key returned no cursor");
    }
    const resumed = decodeCursor(cursor, SITE, "active");
    expect(resumed).toEqual({
      pk: `SITE#${SITE}`,
      sk: lastKey.sk,
      openAlertPk: "SITE#paris-01#OPEN",
      openAlertSk: lastKey.openAlertSk,
    });
  });

  it("queries the resolved partition from the since time, newest first", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [await storedItemOf(OPEN_ALERT)] });
    const store = storeOver(send);

    await store.list({ siteId: SITE, status: "resolved", since: OPENED_AT, limit: 50 });

    expect((sentCommands(send)[0] as QueryCommand).input).toMatchObject({
      IndexName: "openAlerts",
      KeyConditionExpression: "openAlertPk = :p AND openAlertSk >= :since",
      ExpressionAttributeValues: { ":p": "SITE#paris-01#RESOLVED", ":since": OPENED_AT },
      ScanIndexForward: false,
      Limit: 50,
    });
  });

  it("filters the resolved history by severity, since the severity is not in its index key", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [] });
    const store = storeOver(send);

    await store.list({ siteId: SITE, status: "resolved", severity: "MAJOR", limit: 50 });

    expect((sentCommands(send)[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "openAlertPk = :p",
      FilterExpression: "severity = :severity",
      ExpressionAttributeValues: { ":p": "SITE#paris-01#RESOLVED", ":severity": "MAJOR" },
    });
  });

  it("counts a stored item that does not match the schema and leaves it out of the page", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Items: [await storedItemOf(OPEN_ALERT), { pk: `SITE#${SITE}`, kind: "AUDIT" }],
    });
    const store = storeOver(send);

    const page = await store.list({ siteId: SITE, status: "active", limit: 50 });

    expect(page.alerts).toEqual([OPEN_ALERT]);
    expect(page.invalidItems).toBe(1);
  });

  it("starts from a cursor of the same status, with the partitions of the verified site", async () => {
    const cursor = encodeCursor(
      {
        pk: "SITE#paris-01",
        sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
        openAlertPk: "SITE#paris-01#OPEN",
        openAlertSk: `MAJOR#${OPENED_AT}`,
      },
      "active",
    );
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [] });
    const store = storeOver(send);

    await store.list({ siteId: "paris-01", status: "active", limit: 50, cursor });

    expect((sentCommands(send)[0] as QueryCommand).input.ExclusiveStartKey).toEqual({
      pk: "SITE#paris-01",
      sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
      openAlertPk: "SITE#paris-01#OPEN",
      openAlertSk: `MAJOR#${OPENED_AT}`,
    });
  });

  it("refuses a cursor of the other status without querying", async () => {
    const resolvedCursor = encodeCursor(
      {
        sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
        openAlertSk: `${RESOLVED_AT}#${OPEN_ALERT.alertId}`,
      },
      "resolved",
    );
    const send = sendStub();
    const store = storeOver(send);

    await expect(
      store.list({ siteId: SITE, status: "active", limit: 50, cursor: resolvedCursor }),
    ).rejects.toBeInstanceOf(AlertCursorError);
    expect(send).not.toHaveBeenCalled();
  });

  it("maps a ValidationException raised by the table on a reused cursor to a cursor error", async () => {
    const cursor = encodeCursor(
      {
        sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
        openAlertSk: `MAJOR#${OPENED_AT}`,
      },
      "active",
    );
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ValidationException"));
    const store = storeOver(send);

    await expect(
      store.list({ siteId: SITE, status: "active", limit: 50, cursor }),
    ).rejects.toBeInstanceOf(AlertCursorError);
  });

  it("calls the rejected-cursor callback once when the table rejects a reused cursor", async () => {
    const cursor = encodeCursor(
      {
        sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
        openAlertSk: `MAJOR#${OPENED_AT}`,
      },
      "active",
    );
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ValidationException"));
    const onCursorRejected = vi.fn<() => void>();
    const store = storeOver(send, undefined, onCursorRejected);

    await expect(
      store.list({ siteId: SITE, status: "active", limit: 50, cursor }),
    ).rejects.toBeInstanceOf(AlertCursorError);
    expect(onCursorRejected).toHaveBeenCalledTimes(1);
  });

  it("does not call the rejected-cursor callback when a query without a cursor fails", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ValidationException"));
    const onCursorRejected = vi.fn<() => void>();
    const store = storeOver(send, undefined, onCursorRejected);

    await expect(store.list({ siteId: SITE, status: "active", limit: 50 })).rejects.toThrow();
    expect(onCursorRejected).not.toHaveBeenCalled();
  });

  it("rethrows a ValidationException of a query without a cursor, since no client input caused it", async () => {
    const send = sendStub();
    const failure = awsError("ValidationException");
    send.mockRejectedValueOnce(failure);
    const store = storeOver(send);

    await expect(store.list({ siteId: SITE, status: "active", limit: 50 })).rejects.toBe(failure);
  });

  it("rethrows any other failure on a reused cursor", async () => {
    const cursor = encodeCursor(
      {
        sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
        openAlertSk: `MAJOR#${OPENED_AT}`,
      },
      "active",
    );
    const send = sendStub();
    const failure = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(failure);
    const store = storeOver(send);

    await expect(store.list({ siteId: SITE, status: "active", limit: 50, cursor })).rejects.toBe(
      failure,
    );
  });
});

describe("cursors", () => {
  const ACTIVE_KEY = {
    pk: "SITE#paris-01",
    sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}`,
    openAlertPk: "SITE#paris-01#OPEN",
    openAlertSk: `MAJOR#${OPENED_AT}`,
  };

  it("round-trips the position of a page", () => {
    const cursor = encodeCursor(ACTIVE_KEY, "active");

    expect(decodeCursor(cursor, SITE, "active")).toEqual({
      pk: "SITE#paris-01",
      sk: ACTIVE_KEY.sk,
      openAlertPk: "SITE#paris-01#OPEN",
      openAlertSk: ACTIVE_KEY.openAlertSk,
    });
  });

  it("refuses to encode a key that is not an alert", () => {
    const auditKey = {
      sk: `${OPENED_AT}#AUDIT#${ACK_AUDIT_ID}`,
      openAlertSk: `MAJOR#${OPENED_AT}`,
    };

    expect(() => encodeCursor(auditKey, "active")).toThrow();
  });

  it("refuses a cursor whose position belongs to an audit record", () => {
    const cursor = AlertCursorSchema.parse(
      Buffer.from(
        JSON.stringify({ sk: `${OPENED_AT}#AUDIT#${ACK_AUDIT_ID}`, gsk: `MAJOR#${OPENED_AT}` }),
      ).toString("base64url"),
    );

    expect(() => decodeCursor(cursor, SITE, "active")).toThrow(AlertCursorError);
  });

  it("refuses a cursor that carries an extra key attribute", () => {
    const cursor = AlertCursorSchema.parse(
      Buffer.from(
        JSON.stringify({ pk: "SITE#other-site", sk: ACTIVE_KEY.sk, gsk: ACTIVE_KEY.openAlertSk }),
      ).toString("base64url"),
    );

    expect(() => decodeCursor(cursor, SITE, "active")).toThrow(AlertCursorError);
  });

  it("refuses a cursor that is not JSON", () => {
    const cursor = AlertCursorSchema.parse(Buffer.from("not json").toString("base64url"));

    expect(() => decodeCursor(cursor, SITE, "active")).toThrow(AlertCursorError);
  });

  it("refuses a resolved position used as an active one", () => {
    const cursor = encodeCursor(
      { sk: ACTIVE_KEY.sk, openAlertSk: `${RESOLVED_AT}#${OPEN_ALERT.alertId}` },
      "resolved",
    );

    expect(() => decodeCursor(cursor, SITE, "active")).toThrow(AlertCursorError);
  });
});

describe("DynamoDbAlertStore.get", () => {
  it("reads the alert by its key with a consistent read", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: await storedItemOf(OPEN_ALERT) });
    const store = storeOver(send);

    await expect(store.get(SITE, OPEN_ALERT.alertId, OPEN_ALERT.openedAt)).resolves.toEqual(
      OPEN_ALERT,
    );

    expect(sentCommands(send)[0]).toBeInstanceOf(GetCommand);
    expect((sentCommands(send)[0] as GetCommand).input).toEqual({
      TableName: EVENTS,
      Key: { pk: "SITE#paris-01", sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}` },
      ConsistentRead: true,
    });
  });

  it("returns null when no item has the key", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const store = storeOver(send);

    await expect(store.get(SITE, OPEN_ALERT.alertId, OPEN_ALERT.openedAt)).resolves.toBeNull();
  });

  it("returns null when the stored item is not a valid alert", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: { pk: `SITE#${SITE}`, kind: "AUDIT" } });
    const store = storeOver(send);

    await expect(store.get(SITE, OPEN_ALERT.alertId, OPEN_ALERT.openedAt)).resolves.toBeNull();
  });
});

describe("DynamoDbAlertStore.acknowledge", () => {
  const transition: AlertTransition = {
    current: OPEN_ALERT,
    next: ACKNOWLEDGED_ALERT,
    audit: ACK_AUDIT,
  };

  it("commits the acknowledgement and its audit record in one transaction, with the audit id as token", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const store = storeOver(send);

    await expect(store.acknowledge(transition)).resolves.toBe("APPLIED");

    const input = (sentCommands(send)[0] as TransactWriteCommand).input;
    expect(input.ClientRequestToken).toBe(ACK_AUDIT_ID);
    const [update, audit] = input.TransactItems ?? [];
    expect(update?.Update).toEqual({
      TableName: EVENTS,
      Key: { pk: "SITE#paris-01", sk: `${OPENED_AT}#ALERT#${OPEN_ALERT.alertId}` },
      UpdateExpression: "SET #status = :ack, acknowledgedBy = :by, acknowledgedAt = :at",
      ConditionExpression: "#status = :open AND alertId = :id",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":ack": "ACKNOWLEDGED",
        ":open": "OPEN",
        ":id": OPEN_ALERT.alertId,
        ":by": ACTOR,
        ":at": ACKNOWLEDGED_AT,
      },
    });
    expect(audit?.Put).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: {
        pk: "SITE#paris-01",
        kind: "AUDIT",
        auditId: ACK_AUDIT_ID,
        action: "alert.acknowledge",
      },
    });
    expect(input.TransactItems).toHaveLength(2);
  });

  it("reports a conflict when the alert is no longer OPEN", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None"));
    const store = storeOver(send);

    await expect(store.acknowledge(transition)).resolves.toBe("CONFLICT");
  });

  it("rethrows a cancellation of the audit item, and any other failure", async () => {
    const send = sendStub();
    const auditCollision = cancelled("None", "ConditionalCheckFailed");
    const throttled = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(auditCollision);
    send.mockRejectedValueOnce(throttled);
    const store = storeOver(send);

    await expect(store.acknowledge(transition)).rejects.toBe(auditCollision);
    await expect(store.acknowledge(transition)).rejects.toBe(throttled);
  });
});

describe("DynamoDbAlertStore.resolve", () => {
  const transition: AlertTransition = {
    current: ACKNOWLEDGED_ALERT,
    next: RESOLVED_ALERT,
    audit: RESOLVE_AUDIT,
  };

  it("moves the alert to the resolved partition, deletes its marker and writes the audit, in one transaction", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const store = storeOver(send);

    await expect(store.resolve(transition)).resolves.toBe("APPLIED");

    const input = (sentCommands(send)[0] as TransactWriteCommand).input;
    expect(input.ClientRequestToken).toBe(RESOLVE_AUDIT_ID);
    const [update, marker, audit] = input.TransactItems ?? [];
    expect(update?.Update).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "#status = :acked AND alertId = :id",
      ExpressionAttributeValues: {
        ":resolved": "RESOLVED",
        ":acked": "ACKNOWLEDGED",
        ":by": ACTOR,
        ":at": RESOLVED_AT,
        ":rp": "SITE#paris-01#RESOLVED",
        ":rs": `${RESOLVED_AT}#${OPEN_ALERT.alertId}`,
      },
    });
    expect(marker?.Delete).toEqual({
      TableName: FLEET,
      Key: { pk: "SITE#paris-01", sk: "ALERTOPEN#kali-01#BLOCKED" },
      ConditionExpression: "attribute_not_exists(pk) OR alertId = :id",
      ExpressionAttributeValues: { ":id": OPEN_ALERT.alertId },
    });
    expect(audit?.Put).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: { kind: "AUDIT", action: "alert.resolve" },
    });
    expect(input.TransactItems).toHaveLength(3);
  });

  it("reports a conflict when the alert is no longer ACKNOWLEDGED, without a second attempt", async () => {
    const send = sendStub();
    const onMarkerMismatch = vi.fn<() => void>();
    send.mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "ConditionalCheckFailed"));
    const store = storeOver(send, onMarkerMismatch);

    await expect(store.resolve(transition)).resolves.toBe("CONFLICT");
    expect(send).toHaveBeenCalledTimes(1);
    expect(onMarkerMismatch).not.toHaveBeenCalled();
  });

  it("commits the resolution without the marker when the marker names another alert, and reports it", async () => {
    const send = sendStub();
    const onMarkerMismatch = vi.fn<() => void>();
    send.mockRejectedValueOnce(cancelled("None", "ConditionalCheckFailed", "None"));
    send.mockResolvedValueOnce({});
    const store = storeOver(send, onMarkerMismatch);

    await expect(store.resolve(transition)).resolves.toBe("APPLIED");

    expect(onMarkerMismatch).toHaveBeenCalledTimes(1);
    const retry = (sentCommands(send)[1] as TransactWriteCommand).input;
    expect(retry.ClientRequestToken).toBeUndefined();
    expect(retry.TransactItems).toHaveLength(2);
    expect(retry.TransactItems?.some((item) => item.Delete !== undefined)).toBe(false);
  });

  it("reports a conflict when the retry without the marker finds the alert changed", async () => {
    const send = sendStub();
    const onMarkerMismatch = vi.fn<() => void>();
    send.mockRejectedValueOnce(cancelled("None", "ConditionalCheckFailed", "None"));
    send.mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None"));
    const store = storeOver(send, onMarkerMismatch);

    await expect(store.resolve(transition)).resolves.toBe("CONFLICT");
    expect(onMarkerMismatch).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other failure of the transaction", async () => {
    const send = sendStub();
    const failure = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(failure);
    const store = storeOver(send);

    await expect(store.resolve(transition)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
