/**
 * Control state over DynamoDB: the claim of an identifier, the read-back of a replay, and the demo flag.
 */
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DynamoDbCommandClaims,
  DynamoDbDemoStore,
} from "../../src/adapters/dynamodb-control-state";
import type { CommandClaim } from "../../src/domain/control/ports";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";
import { commandIdOf } from "../fakes/control";

const TABLE = "mfc-demo-fleet";
const SITE = "paris-01";

/**
 * A claim the tests write.
 *
 * @param n - Number of the identifier.
 * @returns The claim.
 */
function claimOf(n: number): CommandClaim {
  return {
    commandId: commandIdOf(n),
    robotId: "sim-03",
    type: "PAUSE",
    actor: "00000000-0000-4000-8000-0000000000a1",
    correlationId: "corr-00000001",
    issuedAt: "2026-11-04T10:00:00.000Z",
  };
}

describe("DynamoDbCommandClaims", () => {
  it("claim writes the identifier once, with the one-hour expiry, under a condition", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const claims = new DynamoDbCommandClaims(documentClientStub(send), TABLE);
    const outcome = await claims.claim(SITE, claimOf(1), 1_800_003_600);

    expect(outcome).toEqual({ kind: "CLAIMED" });
    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(PutCommand);
    expect(command).toMatchObject({
      input: {
        TableName: TABLE,
        ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          pk: "SITE#paris-01",
          sk: `CMD#${commandIdOf(1)}`,
          type: "PAUSE",
          expiresAt: 1_800_003_600,
        },
      },
    });
  });

  it("a claimed identifier reads back the stored request with a consistent read", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#paris-01",
        sk: `CMD#${commandIdOf(1)}`,
        expiresAt: 1_800_003_600,
        ...claimOf(1),
      },
    });
    const claims = new DynamoDbCommandClaims(documentClientStub(send), TABLE);
    const outcome = await claims.claim(SITE, claimOf(1), 1_800_003_600);

    expect(outcome).toEqual({ kind: "EXISTS", claim: claimOf(1) });
    const read = sentCommands(send)[1];
    expect(read).toBeInstanceOf(GetCommand);
    expect(read).toMatchObject({
      input: { Key: { pk: "SITE#paris-01", sk: `CMD#${commandIdOf(1)}` }, ConsistentRead: true },
    });
  });

  it("refuses a stored claim that does not match its schema", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    send.mockResolvedValueOnce({ Item: { commandId: "not-a-uuid" } });
    const claims = new DynamoDbCommandClaims(documentClientStub(send), TABLE);
    await expect(claims.claim(SITE, claimOf(1), 1)).rejects.toThrow(
      "stored command claim does not match its schema",
    );
  });

  it("rethrows a claim failure that is not a lost condition", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("InternalServerError"));
    const claims = new DynamoDbCommandClaims(documentClientStub(send), TABLE);
    await expect(claims.claim(SITE, claimOf(1), 1)).rejects.toThrow();
  });

  it("abandon deletes the claim of the identifier", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const claims = new DynamoDbCommandClaims(documentClientStub(send), TABLE);
    await claims.abandon(SITE, commandIdOf(1));

    expect(sentCommands(send)[0]).toBeInstanceOf(DeleteCommand);
    expect(sentCommands(send)[0]).toMatchObject({
      input: { Key: { pk: "SITE#paris-01", sk: `CMD#${commandIdOf(1)}` } },
    });
  });
});

describe("DynamoDbDemoStore", () => {
  it("reads disabled when no flag was ever written", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const demo = new DynamoDbDemoStore(documentClientStub(send), TABLE);

    expect(await demo.get(SITE)).toEqual({ enabled: false });
    expect(sentCommands(send)[0]).toMatchObject({
      input: { Key: { pk: "SITE#paris-01", sk: "DEMO" }, ConsistentRead: true },
    });
  });

  it("reads the stored flag without its keys", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#paris-01",
        sk: "DEMO",
        enabled: true,
        changedBy: "00000000-0000-4000-8000-0000000000a3",
        changedAt: "2026-11-04T10:00:00.000Z",
      },
    });
    const demo = new DynamoDbDemoStore(documentClientStub(send), TABLE);

    expect(await demo.get(SITE)).toEqual({
      enabled: true,
      changedBy: "00000000-0000-4000-8000-0000000000a3",
      changedAt: "2026-11-04T10:00:00.000Z",
    });
  });

  it("set writes the validated state under the demo key", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    const demo = new DynamoDbDemoStore(documentClientStub(send), TABLE);
    const state = await demo.set(SITE, {
      enabled: true,
      changedBy: "00000000-0000-4000-8000-0000000000a3",
      changedAt: "2026-11-04T10:00:00.000Z",
    });

    expect(state.enabled).toBe(true);
    expect(sentCommands(send)[0]).toMatchObject({
      input: { Item: { pk: "SITE#paris-01", sk: "DEMO", enabled: true } },
    });
  });
});
