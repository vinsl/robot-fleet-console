/**
 * In-memory fakes of the alerts ports, and the dependencies and fixtures the alerts tests share.
 *
 * The store fake applies a transition the way the DynamoDB adapter does on success, and can be told to lose
 * the condition of the next transition, which is how a concurrent change is simulated.
 */
import {
  AlertRecordSchema,
  ALERT_SEVERITY_BY_KIND,
  type AlertId,
  type AlertKind,
  type AlertRecord,
  type AuditRecord,
  type IsoMs,
  type SiteId,
} from "@mfc/protocol";
import type { AuditPort } from "../../src/domain/ports";
import type {
  AlertListRequest,
  AlertPage,
  AlertRelayPort,
  AlertStorePort,
  AlertTransition,
  AlertTransitionOutcome,
  AlertCall,
  AlertsDeps,
  AlertsMetrics,
  AlertsMetricName,
} from "../../src/domain/alerts/ports";
import { FixedClock, ScriptedDeadline, SequentialIds } from "./fixed";
import { RecordingLogger } from "./recording";

/** Site of the alert fixtures. */
export const SITE_ID: SiteId = "paris-01";

/** Robot of the alert fixtures. */
export const ROBOT_ID = "sim-03";

/** Identifier of the alert fixtures. */
export const ALERT_ID: AlertId = "0123456789abcdef0123456789abcdef";

/** Opening instant of the alert fixtures. */
export const OPENED_AT: IsoMs = "2026-11-02T10:00:00.000Z";

/** Instant every alerts test starts at. */
export const START_TIME = new Date("2026-11-03T10:00:00.000Z");

/** The verified caller of the alerts tests. */
export const CALL: AlertCall = {
  actor: "user-sub-operator",
  correlationId: "corr-00000001",
};

/**
 * Severity of a kind, as the protocol assigns it.
 *
 * @param kind - The alert kind.
 * @returns Its severity.
 */
function severityOf(kind: AlertKind): AlertRecord["severity"] {
  switch (kind) {
    case "ESTOP":
      return ALERT_SEVERITY_BY_KIND.ESTOP;
    case "BLOCKED":
      return ALERT_SEVERITY_BY_KIND.BLOCKED;
    case "OFFLINE":
      return ALERT_SEVERITY_BY_KIND.OFFLINE;
    case "LOW_BATTERY":
      return ALERT_SEVERITY_BY_KIND.LOW_BATTERY;
  }
}

/**
 * Builds a valid alert record. The severity follows the kind, as the protocol requires.
 *
 * @param overrides - The fields to set on top of the defaults.
 * @returns The record, validated by the protocol schema.
 */
export function alertOf(overrides: Partial<AlertRecord> & { kind?: AlertKind } = {}): AlertRecord {
  const kind = overrides.kind ?? "BLOCKED";
  return AlertRecordSchema.parse({
    alertId: ALERT_ID,
    siteId: SITE_ID,
    robotId: ROBOT_ID,
    severity: severityOf(kind),
    status: "OPEN",
    openedAt: OPENED_AT,
    ...overrides,
    kind,
  });
}

/** Store fake: an in-memory map of alerts, with scripted conflicts and read failures. */
export class FakeAlertStore implements AlertStorePort {
  /** Alerts by identifier. A stored alert is what `get` returns. */
  readonly alerts = new Map<string, AlertRecord>();
  /** Every transaction received, in order, whatever its outcome. */
  readonly transactions: {
    readonly kind: "acknowledge" | "resolve";
    readonly transition: AlertTransition;
  }[] = [];
  /** Every list request received, in order. */
  readonly listRequests: AlertListRequest[] = [];
  /** Number of `get` calls. */
  getCalls = 0;
  /** Page returned by `list`. */
  page: AlertPage = { alerts: [], invalidItems: 0 };
  /** Error thrown by `list` when set. */
  listError: Error | undefined = undefined;
  /** Error thrown by `get` when set. */
  getError: Error | undefined = undefined;

  private readonly conflicts: (AlertRecord | null)[] = [];

  /**
   * Stores an alert, as the robot-side ingest would.
   *
   * @param alert - The alert.
   */
  put(alert: AlertRecord): void {
    this.alerts.set(alert.alertId, alert);
  }

  /**
   * Makes the next transaction lose its condition. The optional replacement is what a concurrent change stored.
   *
   * @param replacement - The alert the concurrent change left, or null to leave the stored alert as it is.
   */
  conflictNext(replacement: AlertRecord | null = null): void {
    this.conflicts.push(replacement);
  }

  /** @inheritdoc */
  list(request: AlertListRequest): Promise<AlertPage> {
    this.listRequests.push(request);
    return this.listError === undefined
      ? Promise.resolve(this.page)
      : Promise.reject(this.listError);
  }

  /** @inheritdoc */
  get(siteId: SiteId, alertId: AlertId, openedAt: IsoMs): Promise<AlertRecord | null> {
    this.getCalls += 1;
    if (this.getError !== undefined) {
      return Promise.reject(this.getError);
    }
    const alert = this.alerts.get(alertId);
    if (alert === undefined || alert.siteId !== siteId || alert.openedAt !== openedAt) {
      return Promise.resolve(null);
    }
    return Promise.resolve(alert);
  }

  /** @inheritdoc */
  acknowledge(transition: AlertTransition): Promise<AlertTransitionOutcome> {
    this.transactions.push({ kind: "acknowledge", transition });
    return Promise.resolve(this.apply(transition));
  }

  /** @inheritdoc */
  resolve(transition: AlertTransition): Promise<AlertTransitionOutcome> {
    this.transactions.push({ kind: "resolve", transition });
    return Promise.resolve(this.apply(transition));
  }

  private apply(transition: AlertTransition): AlertTransitionOutcome {
    const conflict = this.conflicts.shift();
    if (conflict !== undefined) {
      if (conflict !== null) {
        this.alerts.set(conflict.alertId, conflict);
      }
      return "CONFLICT";
    }
    this.alerts.set(transition.next.alertId, transition.next);
    return "APPLIED";
  }
}

/** Relay fake that keeps every change it is asked to send. */
export class FakeAlertRelay implements AlertRelayPort {
  /** Every change relayed, in order. */
  readonly changes: {
    readonly siteId: SiteId;
    readonly change: "ACKNOWLEDGED" | "RESOLVED";
    readonly alert: AlertRecord;
  }[] = [];

  /** @inheritdoc */
  alertChanged(
    siteId: SiteId,
    change: "ACKNOWLEDGED" | "RESOLVED",
    alert: AlertRecord,
  ): Promise<void> {
    this.changes.push({ siteId, change, alert });
    return Promise.resolve();
  }
}

/** Audit fake that keeps every record, and can be told to fail. */
export class FakeAlertAudit implements AuditPort {
  /** Every record written, in order. */
  readonly records: AuditRecord[] = [];
  /** Error thrown by every write when set. */
  failure: Error | undefined = undefined;

  /** @inheritdoc */
  write(record: AuditRecord): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    this.records.push(record);
    return Promise.resolve();
  }
}

/** Metrics fake that counts in memory. */
export class CountingAlertsMetrics implements AlertsMetrics {
  private readonly counts = new Map<AlertsMetricName, number>();

  /** @inheritdoc */
  count(name: AlertsMetricName): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * Number of times a metric was counted.
   *
   * @param name - The metric.
   * @returns The count, zero when never counted.
   */
  value(name: AlertsMetricName): number {
    return this.counts.get(name) ?? 0;
  }
}

/** Every collaborator of the alerts use cases, with the fakes behind them. */
export interface AlertsWorld {
  readonly deps: AlertsDeps;
  readonly store: FakeAlertStore;
  readonly audit: FakeAlertAudit;
  readonly relay: FakeAlertRelay;
  readonly metrics: CountingAlertsMetrics;
  readonly logger: RecordingLogger;
  readonly clock: FixedClock;
  readonly deadline: ScriptedDeadline;
}

/**
 * Builds the dependencies of one alerts test, with fresh fakes.
 *
 * @param remainingMs - The remaining time of the invocation, in milliseconds.
 * @returns The dependencies and the fakes behind them.
 */
export function alertsWorld(remainingMs = 5000): AlertsWorld {
  const store = new FakeAlertStore();
  const audit = new FakeAlertAudit();
  const relay = new FakeAlertRelay();
  const metrics = new CountingAlertsMetrics();
  const logger = new RecordingLogger();
  const clock = new FixedClock(START_TIME);
  const deadline = new ScriptedDeadline(remainingMs);
  const deps: AlertsDeps = {
    store,
    audit,
    relay,
    clock,
    ids: new SequentialIds(),
    deadline,
    logger,
    metrics,
  };
  return { deps, store, audit, relay, metrics, logger, clock, deadline };
}
