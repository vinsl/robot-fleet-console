/**
 * Registry adapter over DynamoDB: the commands it sends and how it maps their outcomes to the port.
 */
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbRegistry } from "../../src/adapters/dynamodb-registry";
import { RobotsError } from "../../src/domain/robots/problems";
import type { RobotRecord } from "../../src/domain/robots/registry";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";
import { recordOf } from "../fakes/world";

const TABLE = "mfc-demo-fleet";
const SITE_KEY = "SITE#paris-01";
const ROBOT_KEY = "ROBOT#kali-01";

/**
 * The item as the table stores it: the record's fields, plus the two keys. Optional fields that are undefined
 * are absent, as the document client leaves them.
 *
 * @param record - The record.
 * @returns The stored item.
 */
function storedItem(record: RobotRecord): Record<string, unknown> {
  const plain: unknown = JSON.parse(JSON.stringify(record));
  return { pk: SITE_KEY, sk: ROBOT_KEY, ...(plain as Record<string, unknown>) };
}

/**
 * Builds a DynamoDB transaction cancellation with the given reason codes.
 *
 * @param codes - One code per item of the transaction.
 * @returns An error named like the SDK's transaction cancellation.
 */
function cancellation(codes: string[]): Error {
  return Object.assign(awsError("TransactionCanceledException"), {
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

/**
 * Builds a refused conditional write as the SDK rejects it. The SDK does not unmarshall the item of a
 * refused write, so the error carries no decoded item: the stored record must be read back.
 *
 * @returns The error, named like the SDK's conditional check failure.
 */
function conditionFailure(): Error {
  return awsError("ConditionalCheckFailedException");
}

/**
 * Builds a refused conditional write that carries a raw item, as the SDK types it. The item is in the
 * DynamoDB attribute-map form, which the registry must not read.
 *
 * @param item - The item the error would carry.
 * @returns The error.
 */
function conditionFailureWithRawItem(item: Record<string, unknown>): Error {
  return Object.assign(awsError("ConditionalCheckFailedException"), {
    Item: Object.fromEntries(
      Object.entries(item).map(([key, value]) => [key, { S: String(value) }]),
    ),
  });
}

const record = recordOf();

describe("DynamoDbRegistry.reserve", () => {
  it("writes the claim and the record in one transaction, with the idempotency token", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.reserve(record, "token-1")).resolves.toBe("reserved");

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command).toMatchObject({
      input: {
        ClientRequestToken: "token-1",
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              ConditionExpression: "attribute_not_exists(pk)",
              Item: {
                pk: "ROBOTID#kali-01",
                sk: "CLAIM",
                siteId: "paris-01",
                createdAt: record.createdAt,
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              ConditionExpression: "attribute_not_exists(pk)",
              Item: { pk: SITE_KEY, sk: ROBOT_KEY, robotId: "kali-01", version: 1 },
            },
          },
        ],
      },
    });
  });

  it("reports taken when a condition of the transaction failed", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(cancellation(["None", "ConditionalCheckFailed"]));
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.reserve(record, "token-1")).resolves.toBe("taken");
  });

  it("rethrows a cancellation that is not a failed condition", async () => {
    const send = sendStub();
    const failure = cancellation(["TransactionConflict"]);
    send.mockRejectedValueOnce(failure);
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.reserve(record, "token-1")).rejects.toBe(failure);
  });

  it("rethrows any other failure", async () => {
    const send = sendStub();
    const failure = awsError("ProvisionedThroughputExceededException");
    send.mockRejectedValueOnce(failure);
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.reserve(record, "token-1")).rejects.toBe(failure);
  });
});

describe("DynamoDbRegistry.get", () => {
  it("reads the robot item with a strongly consistent read and returns null when absent", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.get("paris-01", "kali-01")).resolves.toBeNull();

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(GetCommand);
    expect(command).toMatchObject({
      input: { TableName: TABLE, Key: { pk: SITE_KEY, sk: ROBOT_KEY }, ConsistentRead: true },
    });
  });

  it("returns the record without its keys", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: storedItem(record) });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.get("paris-01", "kali-01")).resolves.toStrictEqual(record);
  });

  it("throws an internal error when the stored item does not match the schema", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: { ...storedItem(record), status: "BROKEN" } });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    const outcome = registry.get("paris-01", "kali-01");
    await expect(outcome).rejects.toBeInstanceOf(RobotsError);
    await expect(outcome).rejects.toMatchObject({ code: "internal" });
  });
});

describe("DynamoDbRegistry.replace", () => {
  const next = { ...recordOf({ version: 2 }), kvsChannelArn: undefined };

  it("writes the record only when the stored version is the expected one", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("ok");

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(PutCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        Item: { pk: SITE_KEY, sk: ROBOT_KEY, version: 2 },
        ConditionExpression: "#version = :expected",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expected": 1 },
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads the stored record back with a strongly consistent read after a refused write", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(conditionFailure());
    send.mockResolvedValueOnce({ Item: storedItem(next) });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await registry.replace(1, next);

    const commands = sentCommands(send);
    expect(commands[1]).toBeInstanceOf(GetCommand);
    expect(commands[1]).toMatchObject({
      input: { TableName: TABLE, Key: { pk: SITE_KEY, sk: ROBOT_KEY }, ConsistentRead: true },
    });
  });

  it("treats a refused write as applied when the stored record equals the one written", async () => {
    const send = sendStub();
    // The refused write carries no item, as the SDK reports it. The stored item has no kvsChannelArn
    // key, as an undefined optional field is never stored.
    send.mockRejectedValueOnce(conditionFailure());
    send.mockResolvedValueOnce({ Item: storedItem(next) });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("ok");
  });

  it("reports a conflict when the stored record differs", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(conditionFailure());
    send.mockResolvedValueOnce({ Item: storedItem(recordOf({ version: 2, name: "Other" })) });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("conflict");
  });

  it("reports a conflict when the record is absent on read-back", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(conditionFailure());
    send.mockResolvedValueOnce({});
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("conflict");
  });

  it("reports a conflict when the stored item does not match the schema", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(conditionFailure());
    send.mockResolvedValueOnce({ Item: { ...storedItem(next), status: "BROKEN" } });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("conflict");
  });

  it("decides from the read-back, never from an item carried by the error", async () => {
    const send = sendStub();
    // The error carries the very record written, in raw form, but the table holds another record.
    send.mockRejectedValueOnce(conditionFailureWithRawItem(storedItem(next)));
    send.mockResolvedValueOnce({ Item: storedItem(recordOf({ version: 2, name: "Other" })) });
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).resolves.toBe("conflict");
  });

  it("rethrows a failure of the read-back", async () => {
    const send = sendStub();
    const failure = awsError("InternalServerError");
    send.mockRejectedValueOnce(conditionFailure());
    send.mockRejectedValueOnce(failure);
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).rejects.toBe(failure);
  });

  it("rethrows any failure that is not a refused condition, without a read-back", async () => {
    const send = sendStub();
    const failure = awsError("InternalServerError");
    send.mockRejectedValueOnce(failure);
    const registry = new DynamoDbRegistry(documentClientStub(send), TABLE);

    await expect(registry.replace(1, next)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("DynamoDbRegistry.list", () => {
  it("queries the robots of the site by prefix, in pages of 50", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [] });
    await new DynamoDbRegistry(documentClientStub(send), TABLE).list("paris-01");

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        KeyConditionExpression: "pk = :site AND begins_with(sk, :robot)",
        ExpressionAttributeValues: { ":site": SITE_KEY, ":robot": "ROBOT#" },
        Limit: 50,
      },
    });
  });

  it("reads at most two pages, even when the table has more", async () => {
    const send = sendStub();
    const lastKey = { pk: SITE_KEY, sk: ROBOT_KEY };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });
    await new DynamoDbRegistry(documentClientStub(send), TABLE).list("paris-01");

    expect(send).toHaveBeenCalledTimes(2);
    expect(sentCommands(send)[1]).toMatchObject({ input: { ExclusiveStartKey: lastKey } });
  });

  it("returns the records of the site and skips an item that does not match the schema, counting it", async () => {
    const send = sendStub();
    const logger = { warn: vi.fn<(message: string, attributes: object) => void>() };
    const record = recordOf();
    send.mockResolvedValueOnce({
      Items: [storedItem(record), { pk: SITE_KEY, sk: "ROBOT#broken", robotId: "broken" }],
    });
    const records = await new DynamoDbRegistry(documentClientStub(send), TABLE, logger).list(
      "paris-01",
    );

    expect(records).toEqual([record]);
    expect(logger.warn).toHaveBeenCalledWith("registry items left out of the list", { count: 1 });
  });

  it("returns an empty list for a site without robots", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    expect(await new DynamoDbRegistry(documentClientStub(send), TABLE).list("paris-01")).toEqual(
      [],
    );
  });
});
