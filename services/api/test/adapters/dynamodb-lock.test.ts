/**
 * Lock adapter over DynamoDB: the conditions and values of each write, the consistent read, and the outcomes the port
 * reports.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbLockStore } from "../../src/adapters/dynamodb-lock";
import type { LockItem } from "../../src/domain/control/ports";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";
import { FIXTURE_TOKEN } from "../fakes/control";

const TABLE = "mfc-demo-fleet";
const SITE = "paris-01";
const ROBOT = "sim-03";
const HOLDER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const NOW = 1_800_000_000;

/**
 * A lock item the tests write.
 *
 * @param holder - The holder subject.
 * @returns The item.
 */
function lockOf(holder: string): LockItem {
  return {
    robotId: ROBOT,
    holder,
    token: FIXTURE_TOKEN,
    acquiredAt: "2026-11-04T10:00:00.000Z",
    expiresAt: NOW + 30,
  };
}

/**
 * Builds the store over a stub.
 *
 * @returns The store and the send mock.
 */
function storeWith() {
  const send = sendStub();
  return { store: new DynamoDbLockStore(documentClientStub(send), TABLE), send };
}

describe("DynamoDbLockStore", () => {
  it("reads the lock with a consistent read on the site and robot keys", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({});
    await store.get(SITE, ROBOT);

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(GetCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        Key: { pk: "SITE#paris-01", sk: "LOCK#sim-03" },
        ConsistentRead: true,
      },
    });
  });

  it("returns null when there is no lock item", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({});
    expect(await store.get(SITE, ROBOT)).toBeNull();
  });

  it("parses the stored item into a lock item of the robot", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#paris-01",
        sk: "LOCK#sim-03",
        holder: HOLDER,
        token: FIXTURE_TOKEN,
        acquiredAt: "2026-11-04T10:00:00.000Z",
        expiresAt: NOW + 30,
      },
    });
    expect(await store.get(SITE, ROBOT)).toEqual(lockOf(HOLDER));
  });

  it("refuses a corrupt stored lock: the caller fails closed", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({
      Item: { pk: "SITE#paris-01", sk: "LOCK#sim-03", holder: "not valid !", token: "short" },
    });
    await expect(store.get(SITE, ROBOT)).rejects.toThrow(
      "stored lock item does not match its schema",
    );
  });

  it("acquire writes the lock only when it is free, expired or the caller's, and returns the previous item", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({});
    const outcome = await store.acquire(SITE, lockOf(HOLDER), NOW);

    expect(outcome).toBe("ACQUIRED");
    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(PutCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        ConditionExpression: "attribute_not_exists(pk) OR #expiresAt <= :now OR #holder = :me",
        ExpressionAttributeValues: { ":now": NOW, ":me": HOLDER },
        ReturnValues: "ALL_OLD",
        Item: {
          pk: "SITE#paris-01",
          sk: "LOCK#sim-03",
          holder: HOLDER,
          token: FIXTURE_TOKEN,
          expiresAt: NOW + 30,
        },
      },
    });
  });

  it("acquire answers REFRESHED when the caller already held a live lock", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({ Attributes: { holder: HOLDER, expiresAt: NOW + 10 } });
    expect(await store.acquire(SITE, lockOf(HOLDER), NOW)).toBe("REFRESHED");
  });

  it("acquire answers ACQUIRED when the caller's own lock had expired", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({ Attributes: { holder: HOLDER, expiresAt: NOW - 1 } });
    expect(await store.acquire(SITE, lockOf(HOLDER), NOW)).toBe("ACQUIRED");
  });

  it("acquire answers HELD when the condition fails for another live holder", async () => {
    const { store, send } = storeWith();
    send.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    expect(await store.acquire(SITE, lockOf(OTHER), NOW)).toBe("HELD");
  });

  it("acquire rethrows any other failure", async () => {
    const { store, send } = storeWith();
    send.mockRejectedValueOnce(awsError("ProvisionedThroughputExceededException"));
    await expect(store.acquire(SITE, lockOf(HOLDER), NOW)).rejects.toThrow();
  });

  it("refresh moves the expiry only for the holder, the token and a live lock", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({});
    expect(await store.refresh(SITE, ROBOT, HOLDER, FIXTURE_TOKEN, NOW + 30, NOW)).toBe(true);

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command).toMatchObject({
      input: {
        Key: { pk: "SITE#paris-01", sk: "LOCK#sim-03" },
        UpdateExpression: "SET #expiresAt = :expires",
        ConditionExpression: "#holder = :holder AND #token = :token AND #expiresAt > :now",
        ExpressionAttributeValues: {
          ":expires": NOW + 30,
          ":holder": HOLDER,
          ":token": FIXTURE_TOKEN,
          ":now": NOW,
        },
      },
    });
  });

  it("refresh answers false when the condition no longer holds", async () => {
    const { store, send } = storeWith();
    send.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    expect(await store.refresh(SITE, ROBOT, OTHER, FIXTURE_TOKEN, NOW + 30, NOW)).toBe(false);
  });

  it("release deletes only for the holder and the token", async () => {
    const { store, send } = storeWith();
    send.mockResolvedValueOnce({});
    expect(await store.release(SITE, ROBOT, HOLDER, FIXTURE_TOKEN)).toBe(true);

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command).toMatchObject({
      input: {
        Key: { pk: "SITE#paris-01", sk: "LOCK#sim-03" },
        ConditionExpression: "#holder = :holder AND #token = :token",
        ExpressionAttributeValues: { ":holder": HOLDER, ":token": FIXTURE_TOKEN },
      },
    });
  });

  it("release answers false when the condition no longer holds", async () => {
    const { store, send } = storeWith();
    send.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    expect(await store.release(SITE, ROBOT, OTHER, FIXTURE_TOKEN)).toBe(false);
  });
});
