/**
 * History over DynamoDB: one item per state change and per mission, keyed by message, with the retention.
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbHistory } from "../../src/adapters/dynamodb-history";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const TABLE = "mfc-demo-events";
const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";
const TS = "2026-11-02T10:00:00.000Z";

describe("DynamoDbHistory", () => {
  it("writes a state change with a seven-day expiry, keyed by time and message", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const history = new DynamoDbHistory(documentClientStub(send), TABLE);

    await expect(
      history.putState({
        siteId: "paris-01",
        robotId: "kali-01",
        ts: TS,
        messageId: MESSAGE,
        from: "MOVING",
        to: "BLOCKED",
        cause: "OBSTACLE_DETECTED",
      }),
    ).resolves.toBe("WRITTEN");

    const command = sentCommands(send)[0];
    expect(command).toBeInstanceOf(PutCommand);
    expect((command as PutCommand).input).toMatchObject({
      TableName: TABLE,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: {
        pk: "SITE#paris-01",
        sk: `${TS}#STATE#${MESSAGE}`,
        kind: "STATE",
        to: "BLOCKED",
        byRobotPk: "ROBOT#kali-01",
        expiresAt: Math.floor(Date.parse(TS) / 1000) + 7 * 86_400,
      },
    });
  });

  it("writes a mission with a thirty-day expiry", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const history = new DynamoDbHistory(documentClientStub(send), TABLE);

    await history.putMission({
      siteId: "paris-01",
      robotId: "kali-01",
      ts: TS,
      messageId: MESSAGE,
    });

    const command = sentCommands(send)[0] as PutCommand;
    expect(command.input.Item).toMatchObject({
      kind: "MISSION",
      sk: `${TS}#MISSION#${MESSAGE}`,
      expiresAt: Math.floor(Date.parse(TS) / 1000) + 30 * 86_400,
    });
  });

  it("reports a repeated message as DUPLICATE", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const history = new DynamoDbHistory(documentClientStub(send), TABLE);

    await expect(
      history.putMission({ siteId: "paris-01", robotId: "kali-01", ts: TS, messageId: MESSAGE }),
    ).resolves.toBe("DUPLICATE");
  });

  it("rethrows any other failure", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("InternalServerError"));
    const history = new DynamoDbHistory(documentClientStub(send), TABLE);

    await expect(
      history.putMission({ siteId: "paris-01", robotId: "kali-01", ts: TS, messageId: MESSAGE }),
    ).rejects.toThrow("InternalServerError");
  });
});
