/**
 * HTTP contract of the alerts API: the list query, the list page and the two operator actions.
 *
 * Every schema here is strict, so an unknown parameter or field is refused rather than ignored. The
 * action body carries only the locator of the alert (its opening time); the API takes the actor and the
 * time from the verified token and the server clock, never from the client.
 */
import { z } from "zod";
import {
  AlertRecordSchema,
  AlertSeveritySchema,
  type AlertRecord,
  type AlertSeverity,
} from "./alerts";
import { RobotIdSchema } from "./ids";
import { IsoMsSchema } from "./time";

/** Largest page the list endpoint returns. Bounds the response size and the read units of one request. */
export const ALERT_LIST_MAX_LIMIT = 100;

/** Page size when the client does not ask for one. */
export const ALERT_LIST_DEFAULT_LIMIT = 50;

/**
 * Opaque pagination cursor: base64url, bounded. Its content is private to the API, which validates it
 * again against the site and the status it was issued for.
 */
export const AlertCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);

/** A validated pagination cursor. */
export type AlertCursor = z.infer<typeof AlertCursorSchema>;

/** Lifecycle filter of the list: the open alerts, or the resolved ones. */
export const AlertListStatusSchema = z.enum(["active", "resolved"]);

/** A validated list status filter. */
export type AlertListStatus = z.infer<typeof AlertListStatusSchema>;

/**
 * Query string of GET /sites/{siteId}/alerts. Strict: an unknown parameter is refused. API Gateway joins repeated
 * parameters with commas, which every member refuses. `since` filters on the resolution time and is accepted only
 * with status=resolved.
 */
export const AlertListQuerySchema = z
  .strictObject({
    status: AlertListStatusSchema.default("active"),
    severity: AlertSeveritySchema.optional(),
    robotId: RobotIdSchema.optional(),
    since: IsoMsSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ALERT_LIST_MAX_LIMIT)
      .default(ALERT_LIST_DEFAULT_LIMIT),
    cursor: AlertCursorSchema.optional(),
  })
  .refine((query) => query.since === undefined || query.status === "resolved", {
    path: ["since"],
    message: "since applies to resolved alerts only",
  });

/** A validated and defaulted list query. */
export type AlertListQuery = z.infer<typeof AlertListQuerySchema>;

/** One page of the list. `nextCursor` is present when more alerts may follow. */
export const AlertListResponseSchema = z.strictObject({
  alerts: z.array(AlertRecordSchema).max(ALERT_LIST_MAX_LIMIT),
  nextCursor: AlertCursorSchema.optional(),
});

/** A validated page of alerts. */
export type AlertListResponse = z.infer<typeof AlertListResponseSchema>;

/** The two operator actions on an alert, one route each. */
export const AlertActionSchema = z.enum(["acknowledge", "resolve"]);

/** A validated alert action. */
export type AlertAction = z.infer<typeof AlertActionSchema>;

/** Body of an action: the open time of the alert, which with the path id names its storage key. Nothing else. */
export const AlertActionRequestSchema = z.strictObject({ openedAt: IsoMsSchema });

/** A validated action body. */
export type AlertActionRequest = z.infer<typeof AlertActionRequestSchema>;

/** Result of an action. `changed` is false when the alert was already in the target state (an idempotent repeat). */
export const AlertActionResponseSchema = z.strictObject({
  alert: AlertRecordSchema,
  changed: z.boolean(),
});

/** A validated action result. */
export type AlertActionResponse = z.infer<typeof AlertActionResponseSchema>;

/** Display and sort rank of a severity, most urgent first. */
export const ALERT_SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  CRITICAL: 0,
  MAJOR: 1,
  MINOR: 2,
  INFO: 3,
};

/**
 * Sort order of an alert list: severity rank, then newest `openedAt` first, then `alertId`.
 *
 * The order is total, so two consoles given the same alerts show them in the same order, and a list
 * merged from several pages stays stable.
 *
 * @param a - The first alert.
 * @param b - The second alert.
 * @returns A negative number when `a` comes first, a positive number when `b` comes first, zero when the
 * two alerts are the same alert.
 */
export function compareAlerts(a: AlertRecord, b: AlertRecord): number {
  const byRank = ALERT_SEVERITY_RANK[a.severity] - ALERT_SEVERITY_RANK[b.severity];
  if (byRank !== 0) {
    return byRank;
  }
  if (a.openedAt !== b.openedAt) {
    // Timestamps share one fixed UTC format, so string order is time order.
    return a.openedAt > b.openedAt ? -1 : 1;
  }
  return a.alertId < b.alertId ? -1 : a.alertId > b.alertId ? 1 : 0;
}
