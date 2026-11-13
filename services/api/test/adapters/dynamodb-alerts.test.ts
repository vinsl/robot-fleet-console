/**
 * Alerts over DynamoDB: the transaction of an alert and its marker, the idempotency token, and the two
 * refusals that mean "already known".
 */
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AlertRecordSchema, type AlertRecord } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { DynamoDbAlerts } from "../../src/adapters/dynamodb-alerts";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";
import { openAlertRecord } from "../../src/domain/live/alerts";

const EVENTS = "mfc-demo-events";
const FLEET = "mfc-demo-fleet";
const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";

/** A BLOCKED alert of a robot, built by the domain. */
const ALERT: AlertRecord = openAlertRecord({
  siteId: "paris-01",
  robotId: "kali-01",
  kind: "BLOCKED",
  sourceKey: MESSAGE,
  sourceMessageId: MESSAGE,
  openedAt: "2026-11-02T10:00:00.000Z",
  cause: "OBSTACLE_DETECTED",
});

/**
 * A transaction cancellation with one reason per item.
 *
 * @param codes - The reason code of each item.
 * @returns The error.
 */
function cancelled(...codes: string[]): Error {
  return Object.assign(awsError("TransactionCanceledException"), {
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe("DynamoDbAlerts.open", () => {
  it("writes the alert and its marker in one transaction, with the alert id as the request token", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const alerts = new DynamoDbAlerts(documentClientStub(send), {
      eventsTable: EVENTS,
      fleetTable: FLEET,
    });

    await expect(alerts.open(ALERT)).resolves.toBe("OPENED");

    const command = sentCommands(send)[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const input = (command as TransactWriteCommand).input;
    expect(input.ClientRequestToken).toBe(ALERT.alertId);
    const [alertPut, markerPut] = input.TransactItems ?? [];
    expect(alertPut?.Put).toMatchObject({
      TableName: EVENTS,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: {
        pk: "SITE#paris-01",
        sk: `${ALERT.openedAt}#ALERT#${ALERT.alertId}`,
        kind: "ALERT",
        alertKind: "BLOCKED",
        severity: "MAJOR",
        status: "OPEN",
        byRobotPk: "ROBOT#kali-01",
        openAlertPk: "SITE#paris-01#OPEN",
        openAlertSk: `MAJOR#${ALERT.openedAt}`,
        expiresAt: Math.floor(Date.parse(ALERT.openedAt) / 1000) + 90 * 86_400,
      },
    });
    expect(markerPut?.Put).toMatchObject({
      TableName: FLEET,
      ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: "SITE#paris-01", sk: "ALERTOPEN#kali-01#BLOCKED", alertId: ALERT.alertId },
    });
  });

  it("stores only a record the protocol accepts", () => {
    expect(AlertRecordSchema.safeParse(ALERT).success).toBe(true);
  });

  it("reports a repeated alert (its own item exists) as DUPLICATE", async () => {
    const send = sendStub();
    send.mockRejectedValue(cancelled("ConditionalCheckFailed", "None"));
    const alerts = new DynamoDbAlerts(documentClientStub(send), {
      eventsTable: EVENTS,
      fleetTable: FLEET,
    });

    await expect(alerts.open(ALERT)).resolves.toBe("DUPLICATE");
  });

  it("reports an alert of another message for a robot already open as ALREADY_OPEN", async () => {
    const send = sendStub();
    send.mockRejectedValue(cancelled("None", "ConditionalCheckFailed"));
    const alerts = new DynamoDbAlerts(documentClientStub(send), {
      eventsTable: EVENTS,
      fleetTable: FLEET,
    });

    await expect(alerts.open(ALERT)).resolves.toBe("ALREADY_OPEN");
  });

  it("rethrows a cancellation that is not a condition, and any other failure", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(cancelled("TransactionConflict", "None"));
    send.mockRejectedValueOnce(awsError("ProvisionedThroughputExceededException"));
    const alerts = new DynamoDbAlerts(documentClientStub(send), {
      eventsTable: EVENTS,
      fleetTable: FLEET,
    });

    await expect(alerts.open(ALERT)).rejects.toThrow();
    await expect(alerts.open(ALERT)).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("rethrows a cancellation without reasons", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("TransactionCanceledException"));
    const alerts = new DynamoDbAlerts(documentClientStub(send), {
      eventsTable: EVENTS,
      fleetTable: FLEET,
    });

    await expect(alerts.open(ALERT)).rejects.toThrow("TransactionCanceledException");
  });
});
