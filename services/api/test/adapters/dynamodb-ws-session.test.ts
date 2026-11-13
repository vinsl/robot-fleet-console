/**
 * The WebSocket session store over DynamoDB: the commands it builds (the conditions that make redemption
 * single-use and the subscription conditional), the TTL attributes, and the mapping of the stored items.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbWsSession } from "../../src/adapters/dynamodb-ws-session";
import { tokenExpiresAtSeconds } from "../../src/domain/ws/token";
import { connectionExpiresAtSeconds, type ConnectionRecord } from "../../src/domain/ws/session";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const TABLE = "mfc-demo-connections";
const SUB = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const CONNECTED_MS = Date.parse("2026-11-02T10:00:00.000Z");

/** A connection record of the tests. */
const CONNECTION: ConnectionRecord = {
  connectionId: "abcdef12",
  sub: SUB,
  role: "Operator",
  siteId: "paris-01",
  connectedAtMs: CONNECTED_MS,
  sessionExpiresAtMs: CONNECTED_MS + 55 * 60 * 1000,
  subscribed: false,
};

describe("DynamoDbWsSession.putToken", () => {
  it("stores the hash as the key, never the token, with a TTL and a no-overwrite condition", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await store.putToken({
      tokenHash: HASH,
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      sessionExpiresAtMs: CONNECTED_MS,
      expiresAtMs: CONNECTED_MS + 60_000,
    });

    const command = sentCommands(send)[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toStrictEqual({
      TableName: TABLE,
      Item: {
        pk: `WSTOKEN#${HASH}`,
        sub: SUB,
        role: "Operator",
        siteId: "paris-01",
        sessionExpiresAtMs: CONNECTED_MS,
        expiresAtMs: CONNECTED_MS + 60_000,
        expiresAt: tokenExpiresAtSeconds(CONNECTED_MS + 60_000),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });
});

describe("DynamoDbWsSession.redeemToken", () => {
  it("deletes the token only while it is present and not expired, and returns the old item", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Attributes: {
        pk: `WSTOKEN#${HASH}`,
        sub: SUB,
        role: "Admin",
        siteId: "paris-01",
        sessionExpiresAtMs: CONNECTED_MS,
      },
    });
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    const redeemed = await store.redeemToken(HASH, CONNECTED_MS);

    expect(redeemed).toStrictEqual({
      sub: SUB,
      role: "Admin",
      siteId: "paris-01",
      sessionExpiresAtMs: CONNECTED_MS,
    });
    const command = sentCommands(send)[0] as DeleteCommand;
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command.input).toStrictEqual({
      TableName: TABLE,
      Key: { pk: `WSTOKEN#${HASH}` },
      ConditionExpression: "attribute_exists(pk) AND expiresAtMs > :now",
      ExpressionAttributeValues: { ":now": CONNECTED_MS },
      ReturnValues: "ALL_OLD",
    });
  });

  it("returns null when the condition fails: the token is absent, expired or already used", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.redeemToken(HASH, CONNECTED_MS)).resolves.toBeNull();
  });

  it("returns null when no old item comes back", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.redeemToken(HASH, CONNECTED_MS)).resolves.toBeNull();
  });

  it("rethrows any other failure", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ProvisionedThroughputExceededException"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.redeemToken(HASH, CONNECTED_MS)).rejects.toThrow();
  });

  it("refuses a stored token that breaks its shape", async () => {
    const send = sendStub();
    send.mockResolvedValue({ Attributes: { pk: `WSTOKEN#${HASH}`, sub: "not valid !" } });
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.redeemToken(HASH, CONNECTED_MS)).rejects.toThrow();
  });
});

describe("DynamoDbWsSession.putConnection", () => {
  it("stores an unsubscribed record with the connection TTL, and no site key", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await store.putConnection(CONNECTION);

    const command = sentCommands(send)[0] as PutCommand;
    expect(command.input).toStrictEqual({
      TableName: TABLE,
      Item: {
        pk: "CONN#abcdef12",
        sub: SUB,
        role: "Operator",
        siteId: "paris-01",
        connectedAtMs: CONNECTED_MS,
        sessionExpiresAtMs: CONNECTED_MS + 55 * 60 * 1000,
        subscribed: false,
        expiresAt: connectionExpiresAtSeconds(CONNECTION),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    expect(command.input.Item).not.toHaveProperty("sitePk");
  });
});

describe("DynamoDbWsSession.getConnection", () => {
  it("reads with a consistent read and maps the stored item to the record", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Item: {
        pk: "CONN#abcdef12",
        sub: SUB,
        role: "Operator",
        siteId: "paris-01",
        connectedAtMs: CONNECTED_MS,
        sessionExpiresAtMs: CONNECTED_MS + 1000,
        subscribed: true,
        sitePk: "SITE#paris-01",
        expiresAt: 1,
      },
    });
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    const record = await store.getConnection("abcdef12");

    expect(record).toStrictEqual({
      connectionId: "abcdef12",
      sub: SUB,
      role: "Operator",
      siteId: "paris-01",
      connectedAtMs: CONNECTED_MS,
      sessionExpiresAtMs: CONNECTED_MS + 1000,
      subscribed: true,
    });
    const command = sentCommands(send)[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toMatchObject({
      TableName: TABLE,
      Key: { pk: "CONN#abcdef12" },
      ConsistentRead: true,
    });
  });

  it("returns null for an absent record", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.getConnection("abcdef12")).resolves.toBeNull();
  });

  it("refuses an item whose key is not a connection key", async () => {
    const send = sendStub();
    send.mockResolvedValue({ Item: { pk: "WSTOKEN#x", sub: SUB } });
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.getConnection("abcdef12")).rejects.toThrow();
  });
});

describe("DynamoDbWsSession.subscribe", () => {
  it("sets the flag and the site key only when the record exists", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await expect(store.subscribe("abcdef12", "paris-01")).resolves.toBe(true);

    const command = sentCommands(send)[0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toStrictEqual({
      TableName: TABLE,
      Key: { pk: "CONN#abcdef12" },
      UpdateExpression: "SET subscribed = :subscribed, sitePk = :site",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":subscribed": true, ":site": "SITE#paris-01" },
    });
  });

  it("returns false when the record is gone", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.subscribe("abcdef12", "paris-01")).resolves.toBe(false);
  });

  it("rethrows any other failure", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("InternalServerError"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await expect(store.subscribe("abcdef12", "paris-01")).rejects.toThrow();
  });
});

describe("DynamoDbWsSession.remove", () => {
  it("deletes the connection key", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);
    await store.remove("abcdef12");
    expect((sentCommands(send)[0] as DeleteCommand).input).toStrictEqual({
      TableName: TABLE,
      Key: { pk: "CONN#abcdef12" },
    });
  });
});

describe("DynamoDbWsSession.countFrame", () => {
  const NOW_MS = Date.parse("2026-11-02T10:00:00.000Z");

  it("starts a window with one conditional update when none is open", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await expect(store.countFrame("abcdef12", NOW_MS)).resolves.toBe(true);

    const [command] = sentCommands(send) as UpdateCommand[];
    expect(send).toHaveBeenCalledTimes(1);
    expect(command?.input).toMatchObject({
      TableName: TABLE,
      Key: { pk: "CONN#abcdef12" },
      ExpressionAttributeValues: { ":now": NOW_MS, ":one": 1, ":before": NOW_MS - 1000 },
    });
    expect(command?.input.ConditionExpression).toContain("frameWindowMs <= :before");
  });

  it("counts a frame of the open window while the count is below the limit", async () => {
    const send = sendStub();
    send
      .mockRejectedValueOnce(awsError("ConditionalCheckFailedException"))
      .mockResolvedValueOnce({});
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await expect(store.countFrame("abcdef12", NOW_MS)).resolves.toBe(true);

    const second = sentCommands(send)[1] as UpdateCommand;
    expect(second.input.ExpressionAttributeValues).toMatchObject({ ":limit": 10 });
    expect(second.input.ConditionExpression).toContain("frameCount < :limit");
  });

  it("refuses the frame when the window is full, or the record is absent", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await expect(store.countFrame("abcdef12", NOW_MS)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rethrows an infrastructure failure of either step", async () => {
    const send = sendStub();
    send
      .mockRejectedValueOnce(awsError("ConditionalCheckFailedException"))
      .mockRejectedValueOnce(awsError("ProvisionedThroughputExceededException"));
    const store = new DynamoDbWsSession(documentClientStub(send), TABLE);

    await expect(store.countFrame("abcdef12", NOW_MS)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});
