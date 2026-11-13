/**
 * Alerts: conditions the fleet console must surface until an operator acknowledges or clears them.
 *
 * An alert is opened from a reliable event (QoS 1), never from telemetry, so one condition has one
 * writer. The severity is a function of the kind: an operator cannot be shown a Critical ESTOP as
 * Minor by a malformed record, because the record refuses it.
 */
import { z } from "zod";
import { RobotIdSchema, SiteIdSchema, UserSubSchema } from "./ids";
import { IsoMsSchema } from "./time";
import { Uuidv7Schema } from "./uuidv7";

/** Seconds in one day, for the retention constants below. */
const SECONDS_PER_DAY = 86_400;

/** Conditions that open an alert. A late mission is not one of them: the protocol does not report it. */
export const AlertKindSchema = z.enum(["ESTOP", "BLOCKED", "OFFLINE", "LOW_BATTERY"]);

/** A validated alert kind. */
export type AlertKind = z.infer<typeof AlertKindSchema>;

/** Urgency of an alert, from the most urgent to the least. */
export const AlertSeveritySchema = z.enum(["CRITICAL", "MAJOR", "MINOR", "INFO"]);

/** A validated alert severity. */
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/** Lifecycle of an alert: opened, then acknowledged by an operator, then resolved by the robot or an operator. */
export const AlertStatusSchema = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);

/** A validated alert status. */
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

/** Severity of each kind. A record whose severity differs from this table is refused. */
export const ALERT_SEVERITY_BY_KIND: Readonly<Record<AlertKind, AlertSeverity>> = {
  ESTOP: "CRITICAL",
  BLOCKED: "MAJOR",
  OFFLINE: "MAJOR",
  LOW_BATTERY: "MINOR",
};

/** Alert identifier: the first 32 hexadecimal characters of a digest, so a redelivery maps to the same id. */
export const AlertIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** A validated alert identifier. */
export type AlertId = z.infer<typeof AlertIdSchema>;

/**
 * Cause of an alert, as a short machine token (for example `FAULT_OBSTACLE`). Free text would be
 * stored and shown to operators, so only a token is accepted.
 */
const AlertCauseSchema = z.string().regex(/^[A-Za-z0-9_:]{1,64}$/);

/**
 * One alert. The refinements state the invariants a consumer relies on: the severity follows the
 * kind, the acknowledgement and the resolution are recorded together or not at all, and the status
 * matches the fields that are present.
 */
export const AlertRecordSchema = z
  .strictObject({
    alertId: AlertIdSchema,
    siteId: SiteIdSchema,
    robotId: RobotIdSchema,
    kind: AlertKindSchema,
    severity: AlertSeveritySchema,
    status: AlertStatusSchema,
    openedAt: IsoMsSchema,
    cause: AlertCauseSchema.optional(),
    sourceMessageId: Uuidv7Schema.optional(),
    acknowledgedBy: UserSubSchema.optional(),
    acknowledgedAt: IsoMsSchema.optional(),
    resolvedBy: UserSubSchema.optional(),
    resolvedAt: IsoMsSchema.optional(),
  })
  .superRefine((alert, context) => {
    if (alert.severity !== ALERT_SEVERITY_BY_KIND[alert.kind]) {
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "severity does not match the alert kind",
      });
    }
    const acknowledged = [alert.acknowledgedBy, alert.acknowledgedAt];
    const resolved = [alert.resolvedBy, alert.resolvedAt];
    if (
      acknowledged.some((field) => field !== undefined) !==
      acknowledged.every((field) => field !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedBy"],
        message: "acknowledgedBy and acknowledgedAt are set together",
      });
    }
    if (
      resolved.some((field) => field !== undefined) !==
      resolved.every((field) => field !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolvedBy"],
        message: "resolvedBy and resolvedAt are set together",
      });
    }
    // Timestamps share one fixed UTC format (see IsoMsSchema), so string order is time order.
    if (alert.acknowledgedAt !== undefined && alert.acknowledgedAt < alert.openedAt) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAt"],
        message: "an acknowledgement cannot precede the opening of the alert",
      });
    }
    if (alert.resolvedAt !== undefined && alert.resolvedAt < alert.openedAt) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "a resolution cannot precede the opening of the alert",
      });
    }
    const hasAcknowledgement = alert.acknowledgedAt !== undefined;
    const hasResolution = alert.resolvedAt !== undefined;
    if (alert.status === "OPEN" && (hasAcknowledgement || hasResolution)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "an OPEN alert carries no acknowledgement or resolution",
      });
    }
    if (alert.status === "ACKNOWLEDGED" && (!hasAcknowledgement || hasResolution)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "an ACKNOWLEDGED alert has an acknowledgement and no resolution",
      });
    }
    // A RESOLVED alert may or may not carry an acknowledgement: an operator can acknowledge it before the
    // robot clears the condition, or the condition can clear without anyone acknowledging it.
    if (alert.status === "RESOLVED" && !hasResolution) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "a RESOLVED alert has a resolution",
      });
    }
  });

/** A validated alert record. */
export type AlertRecord = z.infer<typeof AlertRecordSchema>;

/** Time an alert stays in the events table, in seconds. Alerts are kept longer than telemetry for audit. */
export const ALERT_RETENTION_SECONDS = 90 * SECONDS_PER_DAY;

/** Time a live state change stays in the events table, in seconds. */
export const STATE_RECORD_RETENTION_SECONDS = 7 * SECONDS_PER_DAY;

/** Time a completed mission stays in the events table, in seconds. */
export const MISSION_RECORD_RETENTION_SECONDS = 30 * SECONDS_PER_DAY;
