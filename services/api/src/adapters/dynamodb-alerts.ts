/**
 * Alerts over DynamoDB: the alert record in the events table, and a marker in the fleet table that says the
 * robot already has an open alert of that kind.
 *
 * Both writes are one transaction, so an alert is never stored without its marker, nor a marker without its
 * alert. The client request token is the alert identifier: an SDK retry of the same transaction succeeds
 * instead of failing on its own write.
 */
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ALERT_RETENTION_SECONDS,
  type AlertId,
  type AlertKind,
  type AlertRecord,
  type RobotId,
  type SiteId,
} from "@mfc/protocol";
import { isAwsError } from "./aws-errors";
import type { AlertOpenOutcome, AlertPort } from "../domain/live/ports";

/** Tables an alert is written to. */
export interface AlertTables {
  /** The fleet table, which holds the open-alert markers. */
  readonly fleetTable: string;
  /** The events table, which holds the alert records. */
  readonly eventsTable: string;
}

/** Suffix of the status partition of the open alerts, in the `openAlerts` index. */
export const OPEN_PARTITION_SUFFIX = "#OPEN";

/** Suffix of the status partition of the resolved alerts, in the `openAlerts` index. */
export const RESOLVED_PARTITION_SUFFIX = "#RESOLVED";

/**
 * Sort key of an alert item in the events table. Both the open-alert writer and the alert store build the key
 * here, so a record written by one is found by the other.
 *
 * @param openedAt - The opening time of the alert, in the fixed UTC format.
 * @param alertId - The alert identifier.
 * @returns The sort key, `{openedAt}#ALERT#{alertId}`.
 */
export function alertSortKey(openedAt: string, alertId: AlertId): string {
  return `${openedAt}#ALERT#${alertId}`;
}

/**
 * Sort key of the open-alert marker of a robot and kind in the fleet table.
 *
 * @param robotId - The robot.
 * @param kind - The alert kind.
 * @returns The sort key, `ALERTOPEN#{robotId}#{kind}`.
 */
export function alertMarkerSortKey(robotId: RobotId, kind: AlertKind): string {
  return `ALERTOPEN#${robotId}#${kind}`;
}

/**
 * Partition of the `openAlerts` index that holds the alerts of a site in one status. An open alert is listed
 * by severity, a resolved one by resolution time, so both lists are read with one key condition.
 *
 * @param siteId - The site.
 * @param status - `OPEN` for the active alerts, `RESOLVED` for the history.
 * @returns The partition key, `SITE#{siteId}#OPEN` or `SITE#{siteId}#RESOLVED`.
 */
export function statusPartition(siteId: SiteId, status: "OPEN" | "RESOLVED"): string {
  const suffix = status === "OPEN" ? OPEN_PARTITION_SUFFIX : RESOLVED_PARTITION_SUFFIX;
  return `SITE#${siteId}${suffix}`;
}

/**
 * Converts a UTC millisecond time to epoch seconds, for the TTL attribute.
 *
 * @param openedAt - The time, in the fixed UTC format.
 * @returns Whole seconds since the epoch.
 */
function epochSecondsOf(openedAt: string): number {
  return Math.floor(Date.parse(openedAt) / 1000);
}

/**
 * The stored alert item. The record's own `kind` (the alert kind) is kept as `alertKind`, because the events
 * table uses `kind` to tell the item types apart: `ALERT` here, `STATE` and `MISSION` elsewhere.
 *
 * @param alert - The alert record.
 * @returns The item, keyed by site and open time, with the indexes of the console views.
 */
function alertItem(alert: AlertRecord): Record<string, unknown> {
  const { kind, ...fields } = alert;
  return {
    ...fields,
    alertKind: kind,
    pk: `SITE#${alert.siteId}`,
    sk: alertSortKey(alert.openedAt, alert.alertId),
    kind: "ALERT",
    byRobotPk: `ROBOT#${alert.robotId}`,
    byRobotSk: alert.openedAt,
    openAlertPk: statusPartition(alert.siteId, "OPEN"),
    openAlertSk: `${alert.severity}#${alert.openedAt}`,
    expiresAt: epochSecondsOf(alert.openedAt) + ALERT_RETENTION_SECONDS,
  };
}

/**
 * The open-alert marker of a robot and kind. Its presence means the robot has an open alert of that kind.
 *
 * @param alert - The alert record.
 * @returns The marker item, with the same retention as the alert.
 */
function markerItem(alert: AlertRecord): Record<string, unknown> {
  return {
    pk: `SITE#${alert.siteId}`,
    sk: alertMarkerSortKey(alert.robotId, alert.kind),
    alertId: alert.alertId,
    openedAt: alert.openedAt,
    expiresAt: epochSecondsOf(alert.openedAt) + ALERT_RETENTION_SECONDS,
  };
}

/**
 * The cancellation reasons of a failed transaction, one code per item, in the order of the items. Only the
 * code is read: the message of a cancellation can echo the item.
 *
 * @param error - The rejection of the transaction.
 * @returns The codes; an item without a reason is `None`.
 */
export function cancellationCodesOf(error: unknown): string[] {
  if (typeof error !== "object" || error === null || !("CancellationReasons" in error)) {
    return [];
  }
  const reasons: unknown = error.CancellationReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.map((reason: unknown) => {
    if (typeof reason === "object" && reason !== null && "Code" in reason) {
      return typeof reason.Code === "string" ? reason.Code : "None";
    }
    return "None";
  });
}

/** Alerts over the events and fleet tables. */
export class DynamoDbAlerts implements AlertPort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tables - The tables the alert and its marker go to.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tables: AlertTables,
  ) {}

  /**
   * Stores an alert and its marker in one transaction.
   *
   * @param alert - The alert record, validated by the domain.
   * @returns `OPENED`; `DUPLICATE` when this very alert is stored already; `ALREADY_OPEN` when the robot has an
   * open alert of this kind from another message.
   * @throws On any other failure, including a transaction still in progress elsewhere.
   */
  async open(alert: AlertRecord): Promise<AlertOpenOutcome> {
    const condition = "attribute_not_exists(pk)";
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: alert.alertId,
          TransactItems: [
            {
              Put: {
                TableName: this.tables.eventsTable,
                Item: alertItem(alert),
                ConditionExpression: condition,
              },
            },
            {
              Put: {
                TableName: this.tables.fleetTable,
                Item: markerItem(alert),
                ConditionExpression: condition,
              },
            },
          ],
        }),
      );
      return "OPENED";
    } catch (error) {
      if (!isAwsError(error, "TransactionCanceledException")) {
        throw error;
      }
      const [alertCode, markerCode] = cancellationCodesOf(error);
      if (alertCode === "ConditionalCheckFailed") {
        return "DUPLICATE";
      }
      if (markerCode === "ConditionalCheckFailed") {
        return "ALREADY_OPEN";
      }
      throw error;
    }
  }
}
