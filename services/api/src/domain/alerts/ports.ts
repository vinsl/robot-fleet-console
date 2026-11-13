/**
 * Ports of the alerts use cases: the store of the alerts, the relay of their changes, the metrics they count,
 * and the dependencies they share with the other use cases.
 *
 * The ports state the outcome the domain needs rather than the SDK call behind it: `acknowledge` says whether
 * the transaction applied or lost its condition, not which condition failed. The domain therefore never
 * imports an SDK, and the DynamoDB adapter is tested against the same contract as the in-memory fakes.
 */
import type {
  AlertCursor,
  AlertId,
  AlertListStatus,
  AlertRecord,
  AlertSeverity,
  AuditRecord,
  CorrelationId,
  IsoMs,
  RobotId,
  SiteId,
  UserSub,
} from "@mfc/protocol";
import type { AuditPort, Clock, Deadline, DomainLogger, Ids } from "../ports";

/** One page request of the alert list, validated by the query schema. */
export interface AlertListRequest {
  /** Site whose alerts are listed. The partitions of the query are built from it, never from the cursor. */
  readonly siteId: SiteId;
  /** `active` lists OPEN and ACKNOWLEDGED alerts; `resolved` lists the history. */
  readonly status: AlertListStatus;
  /** Only alerts of this severity. */
  readonly severity?: AlertSeverity | undefined;
  /** Only alerts of this robot. */
  readonly robotId?: RobotId | undefined;
  /** Resolved alerts only: those resolved at or after this instant. */
  readonly since?: IsoMs | undefined;
  /** Largest number of stored items to read. */
  readonly limit: number;
  /** Position to resume from, as issued by a previous page. */
  readonly cursor?: AlertCursor | undefined;
}

/** One page of the alert list. */
export interface AlertPage {
  /** The alerts of the page, in the order of the store. */
  readonly alerts: AlertRecord[];
  /** Position of the next page, absent on the last page. */
  readonly nextCursor?: AlertCursor | undefined;
  /** Stored items of the page that do not match the alert schema, and were left out. */
  readonly invalidItems: number;
}

/** Outcome of a conditional transition: applied, or refused because the stored alert no longer matched. */
export type AlertTransitionOutcome = "APPLIED" | "CONFLICT";

/** One transition of an alert, with the audit record that is written in the same transaction. */
export interface AlertTransition {
  /** The alert as read, before the change. */
  readonly current: AlertRecord;
  /** The alert after the change, validated by the alert schema. */
  readonly next: AlertRecord;
  /** The SUCCEEDED audit record written in the same transaction. */
  readonly audit: AuditRecord;
}

/** Thrown by the store when a cursor does not decode to a position of this site and status. */
export class AlertCursorError extends Error {
  /** Creates the error. The message is for logs only and is never sent to a client. */
  constructor() {
    super("alert cursor does not match this site and status");
    this.name = "AlertCursorError";
  }
}

/** Store of the alerts. */
export interface AlertStorePort {
  /**
   * Reads one page of the alert list of a site.
   *
   * @throws {AlertCursorError} When the cursor does not belong to this site and status.
   */
  list(request: AlertListRequest): Promise<AlertPage>;

  /**
   * Strongly consistent read of one alert by its key.
   *
   * @returns The alert, or null when it is absent or when the stored item is not a valid alert.
   */
  get(siteId: SiteId, alertId: AlertId, openedAt: IsoMs): Promise<AlertRecord | null>;

  /**
   * Moves an OPEN alert to ACKNOWLEDGED, in one transaction with the audit record.
   *
   * @returns `APPLIED` when the transaction committed, `CONFLICT` when the stored alert no longer matched.
   */
  acknowledge(transition: AlertTransition): Promise<AlertTransitionOutcome>;

  /**
   * Moves an ACKNOWLEDGED alert to RESOLVED, in one transaction with the audit record. The transaction also
   * deletes the marker of the robot and kind when the marker names this alert.
   *
   * @returns `APPLIED` when the transaction committed, `CONFLICT` when the stored alert no longer matched.
   */
  resolve(transition: AlertTransition): Promise<AlertTransitionOutcome>;
}

/** Sends the `alert.changed` frame of an acknowledgement or a resolution. Never throws. */
export interface AlertRelayPort {
  /**
   * Sends the change to every connected console of the site.
   *
   * @param siteId - The site of the alert.
   * @param change - What changed.
   * @param alert - The alert after the change.
   */
  alertChanged(
    siteId: SiteId,
    change: "ACKNOWLEDGED" | "RESOLVED",
    alert: AlertRecord,
  ): Promise<void>;
}

/** Names of the business metrics of the alerts use cases. */
export type AlertsMetricName =
  | "AlertAcknowledged"
  | "AlertResolved"
  | "AlertActionReplayed"
  | "AlertActionRefused"
  | "AlertNotFound"
  | "AlertItemInvalid"
  | "AlertMarkerMismatch"
  | "AlertCursorRejected"
  | "AlertRelaySkipped"
  | "AuditWriteFailed";

/** Business metrics sink of the alerts use cases. */
export interface AlertsMetrics {
  /** Adds one to the named counter. */
  count(name: AlertsMetricName): void;
}

/** The verified caller of an alert action, and the correlation identifier of the invocation. */
export interface AlertCall {
  /** Subject of the verified access token. It is also the declared actor of the audit record. */
  readonly actor: UserSub;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/** Dependencies of the alerts use cases. */
export interface AlertsDeps {
  /** Store of the alerts. */
  readonly store: AlertStorePort;
  /** Audit trail of the operator actions. */
  readonly audit: AuditPort;
  /** Relay of the `alert.changed` frames. */
  readonly relay: AlertRelayPort;
  /** Source of the current instant. */
  readonly clock: Clock;
  /** Source of identifiers. */
  readonly ids: Ids;
  /** Remaining time of the invocation. */
  readonly deadline: Deadline;
  /** Structured logger. */
  readonly logger: DomainLogger;
  /** Business metrics sink. */
  readonly metrics: AlertsMetrics;
}
