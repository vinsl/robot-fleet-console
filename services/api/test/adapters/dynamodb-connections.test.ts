/**
 * Connections over DynamoDB: the bySite listing with its page bound, the shape check of stored items, and the
 * removal of a record.
 */
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbConnections } from "../../src/adapters/dynamodb-connections";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const TABLE = "mfc-demo-connections";
const SUB = "00000000-0000-4000-8000-000000000001";

/**
 * A stored connection, as the index projects it.
 *
 * @param id - The connection identifier.
 * @returns The item.
 */
function item(id: string): Record<string, unknown> {
  return { pk: `CONN#${id}`, role: "Operator", sessionExpiresAtMs: 1_793_617_200_000 };
}

describe("DynamoDbConnections.listSubscribed", () => {
  it("queries the bySite index of the site and maps each item to a connection", async () => {
    const send = sendStub();
    send.mockResolvedValue({ Items: [item("abcdef12")] });
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    const listed = await connections.listSubscribed("paris-01");

    expect(listed).toStrictEqual({
      connections: [
        {
          connectionId: "abcdef12",
          role: "Operator",
          sessionExpiresAtMs: 1_793_617_200_000,
        },
      ],
      truncated: false,
    });
    const command = sentCommands(send)[0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect((command as QueryCommand).input).toMatchObject({
      TableName: TABLE,
      IndexName: "bySite",
      KeyConditionExpression: "sitePk = :site",
      ExpressionAttributeValues: { ":site": "SITE#paris-01" },
      Limit: 100,
    });
  });

  it("follows the pages and reports truncation after three pages", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Items: [item("abcdef12")],
      LastEvaluatedKey: { pk: "CONN#abcdef12" },
    });
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    const listed = await connections.listSubscribed("paris-01");

    expect(send).toHaveBeenCalledTimes(3);
    expect(listed.truncated).toBe(true);
    expect(listed.connections).toHaveLength(3);
  });

  it("passes the start key of the next page", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: "CONN#x" } });
    send.mockResolvedValueOnce({ Items: [] });
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    await connections.listSubscribed("paris-01");

    expect((sentCommands(send)[1] as QueryCommand).input.ExclusiveStartKey).toStrictEqual({
      pk: "CONN#x",
    });
  });

  it("reads an item with the index key the bySite projection returns", async () => {
    const send = sendStub();
    send.mockResolvedValue({ Items: [{ ...item("abcdef12"), sitePk: "SITE#paris-01" }] });
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    const listed = await connections.listSubscribed("paris-01");

    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]?.connectionId).toBe("abcdef12");
  });

  it("refuses a stored item that breaks its shape, so a corrupt session is never served", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Items: [{ pk: "CONN#abcdef12", sub: SUB, role: "Root", sessionExpiresAtMs: 1 }],
    });
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    await expect(connections.listSubscribed("paris-01")).rejects.toThrow();
  });
});

describe("DynamoDbConnections.remove", () => {
  it("deletes the record of the connection", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const connections = new DynamoDbConnections(documentClientStub(send), TABLE);

    await connections.remove("abcdef12");

    const command = sentCommands(send)[0];
    expect(command).toBeInstanceOf(DeleteCommand);
    expect((command as DeleteCommand).input).toStrictEqual({
      TableName: TABLE,
      Key: { pk: "CONN#abcdef12" },
    });
  });
});
