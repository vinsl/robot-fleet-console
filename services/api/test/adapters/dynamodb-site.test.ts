/**
 * Site store over DynamoDB, the activation write: the state condition is the only cancellation that means "not
 * valid", every other failure of the transaction is rethrown.
 */
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MAP_MAX_VERSIONS } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { DynamoDbSiteStore } from "../../src/adapters/dynamodb-site";
import type { MapRecord, PinnedMap } from "../../src/domain/site/ports";
import { documentClientStub, sendStub, sentCommands, type SendMock } from "../fakes/sdk-stub";

const TABLE = "mfc-demo-fleet";
const SITE = "paris-01";
const NOW_ISO = "2026-11-03T10:00:00.000Z";
const EXPIRES_AT = 1_793_000_000;

/** The draft of a pending record, as the domain builds it for the allocated number. */
function draftOf(version: number): MapRecord {
  return {
    version,
    status: "PENDING",
    createdAt: NOW_ISO,
    createdBy: "00000000-0000-4000-8000-000000000001",
    s3Key: `sites/${SITE}/maps/${String(version).padStart(6, "0")}.geojson`,
    s3VersionId: null,
    sha256: null,
    sizeBytes: null,
    summary: null,
  };
}

/**
 * The profile item the consistent read returns, with the counter at the given value.
 *
 * @param nextVersion - The counter value stored.
 * @returns The output of the read.
 */
function profileRead(nextVersion: number): object {
  return { Item: { pk: `SITE#${SITE}`, sk: "META", nextVersion } };
}

/**
 * A transaction cancellation with the given reason codes, as the SDK raises it.
 *
 * @param codes - The reason code of each item.
 * @returns The error.
 */
function transactionCancelled(...codes: string[]): Error {
  return Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

/**
 * Scripts the reads and transactions of one reservation: a counter read per attempt, then the outcome of the
 * transaction of that attempt.
 *
 * @param send - The mock of the client.
 * @param attempts - For each attempt, the counter read and the outcome of its transaction.
 */
function scriptReservations(
  send: SendMock,
  attempts: readonly { read: number; outcome: Error | null }[],
): void {
  for (const attempt of attempts) {
    send.mockResolvedValueOnce(profileRead(attempt.read));
    if (attempt.outcome === null) {
      send.mockResolvedValueOnce({});
    } else {
      send.mockRejectedValueOnce(attempt.outcome);
    }
  }
}

/**
 * A transaction cancellation as the SDK raises it: the name and one reason per item.
 *
 * @param codes - The reason code of each item, in the order the transaction named them.
 * @returns The error.
 */
function cancelled(...codes: string[]): Error {
  return Object.assign(
    new Error("Transaction cancelled, please refer cancellation reasons for specific reasons"),
    {
      name: "TransactionCanceledException",
      CancellationReasons: codes.map((Code) => ({ Code })),
    },
  );
}

describe("DynamoDbSiteStore.activate", () => {
  it("activates a valid version in one transaction and reports it", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.activate(SITE, 2, NOW_ISO)).resolves.toBe("activated");

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(TransactWriteCommand);
  });

  it("reports not-valid when the state condition failed", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None"));
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.activate(SITE, 2, NOW_ISO)).resolves.toBe("not-valid");
  });

  it("rethrows a cancellation with no state condition, such as a conflict", async () => {
    const send = sendStub();
    const error = cancelled("None", "TransactionConflict");
    send.mockRejectedValueOnce(error);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.activate(SITE, 2, NOW_ISO)).rejects.toBe(error);
  });

  it("rethrows a cancellation that carries no reasons", async () => {
    const send = sendStub();
    const error = Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    send.mockRejectedValueOnce(error);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.activate(SITE, 2, NOW_ISO)).rejects.toBe(error);
  });

  it("rethrows a failure that is not a cancellation, such as throttling", async () => {
    const send = sendStub();
    const error = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    send.mockRejectedValueOnce(error);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.activate(SITE, 2, NOW_ISO)).rejects.toBe(error);
  });
});

describe("DynamoDbSiteStore.reserveMap", () => {
  it("allocates the next number and writes its PENDING record in one transaction", async () => {
    const send = sendStub();
    scriptReservations(send, [{ read: 2, outcome: null }]);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).resolves.toBe(3);

    const commands = sentCommands(send);
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands).toHaveLength(2);
    const transaction = commands[1];
    if (!(transaction instanceof TransactWriteCommand)) {
      throw new Error("the reservation is not a transaction");
    }
    const [counter, record] = transaction.input.TransactItems ?? [];
    expect(counter?.Update).toMatchObject({
      Key: { pk: `SITE#${SITE}`, sk: "META" },
      UpdateExpression: "SET #nextVersion = :version",
      ExpressionAttributeValues: { ":version": 3, ":current": 2, ":max": MAP_MAX_VERSIONS },
    });
    expect(counter?.Update?.ConditionExpression).toContain("#nextVersion < :max");
    expect(record?.Put).toMatchObject({
      Item: {
        pk: `SITE#${SITE}`,
        sk: "MAP#000003",
        kind: "MAP",
        version: 3,
        status: "PENDING",
        s3Key: `sites/${SITE}/maps/000003.geojson`,
        expiresAt: EXPIRES_AT,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("treats an absent counter as zero, so a site's first map is version 1", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).resolves.toBe(1);

    const transaction = sentCommands(send)[1];
    if (!(transaction instanceof TransactWriteCommand)) {
      throw new Error("the reservation is not a transaction");
    }
    expect(transaction.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":current": 0,
      ":version": 1,
    });
  });

  it("refuses at the cap from the read, and writes nothing", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce(profileRead(MAP_MAX_VERSIONS));
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-reads and retries when the counter moved under the read, and never reuses a number", async () => {
    const send = sendStub();
    scriptReservations(send, [
      { read: 2, outcome: transactionCancelled("ConditionalCheckFailed", "None") },
      { read: 3, outcome: null },
    ]);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).resolves.toBe(4);

    const retry = sentCommands(send)[3];
    if (!(retry instanceof TransactWriteCommand)) {
      throw new Error("the retry is not a transaction");
    }
    expect(retry.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":current": 3,
      ":version": 4,
    });
  });

  it("retries a transaction conflict with another transaction", async () => {
    const send = sendStub();
    const conflict = Object.assign(new Error("conflict"), {
      name: "TransactionConflictException",
    });
    scriptReservations(send, [
      { read: 0, outcome: conflict },
      { read: 0, outcome: null },
    ]);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).resolves.toBe(1);
  });

  it("gives up after its attempts when every attempt conflicts", async () => {
    const send = sendStub();
    send.mockImplementation((command: unknown) =>
      command instanceof TransactWriteCommand
        ? Promise.reject(transactionCancelled("TransactionConflict", "None"))
        : Promise.resolve(profileRead(1)),
    );
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).rejects.toThrow(
      "map version reservation kept conflicting",
    );
  });

  it("rethrows a failure that is not a conflict, such as throttling, without a retry", async () => {
    const send = sendStub();
    const throttled = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    scriptReservations(send, [{ read: 0, outcome: throttled }]);
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.reserveMap(SITE, MAP_MAX_VERSIONS, draftOf, EXPIRES_AT)).rejects.toBe(
      throttled,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("DynamoDbSiteStore.markValid", () => {
  const PINNED: PinnedMap = {
    s3VersionId: "v-pinned-1",
    sha256: "a".repeat(64),
    sizeBytes: 1234,
    summary: {
      counts: { wall: 1, obstacle: 0, charger: 0, workstation: 0, nogo: 0 },
      extentM: { x: 10, y: 10 },
    },
  };

  it("pins the version and removes its expiry, so the table TTL cannot delete a validated map", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const store = new DynamoDbSiteStore(documentClientStub(send), TABLE);

    await expect(store.markValid(SITE, 1, PINNED)).resolves.toBe("updated");

    const [command] = sentCommands(send);
    if (!(command instanceof UpdateCommand)) {
      throw new Error("the pin is not an update");
    }
    expect(command.input.UpdateExpression).toContain("REMOVE #expiresAt");
    expect(command.input.ExpressionAttributeNames).toMatchObject({ "#expiresAt": "expiresAt" });
    expect(command.input.ConditionExpression).toBe("#status = :pending");
  });
});
