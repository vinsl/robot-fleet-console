/**
 * Presentation rules of the alerts, as pure functions: the visual of a severity, the sentence of an alert, who
 * acted on it, the alert the pill shows, and the order the operator reads.
 *
 * The API orders active alerts by a string key (`SEVERITY#openedAt`) that is not the urgency order, so every
 * list the console shows is sorted here with {@link compareAlerts} first. Nothing else decides the order.
 *
 * @module alerts/alert-text
 */
import type { TFunction } from "i18next";
import { compareAlerts, type AlertRecord, type AlertSeverity, type Role } from "@mfc/protocol";
import { ApiError } from "../api/http-client";
import { ALERT_VISUALS } from "../theme/robot-state-visuals";

/** Severities in display order, most urgent first. Groups follow this order, empty groups are left out. */
const SEVERITY_ORDER: readonly AlertSeverity[] = ["CRITICAL", "MAJOR", "MINOR", "INFO"];

/** Hex digits of the subject shown as an operator identifier. Long enough to tell two operators apart. */
const ACTOR_ID_LENGTH = 4;

/** Visual of one severity: label key, colour, icon and sound policy. */
export type AlertVisual = (typeof ALERT_VISUALS)[keyof typeof ALERT_VISUALS];

/** Keys of the failure messages of an operator action, in the `alerts` namespace. */
export type AlertErrorKey = "error.conflict" | "error.notFound" | "error.action";

/** The alert the pill shows, and how many open Critical or Major alerts there are. */
export interface PillSummary {
  /** The most urgent, then the newest, of the open Critical or Major alerts; `null` when there is none. */
  readonly alert: AlertRecord | null;
  /** Number of open Critical or Major alerts. */
  readonly count: number;
}

/**
 * Maps a protocol severity to its visual. A switch keeps the lookup on the closed union.
 *
 * @param severity - The protocol severity, `CRITICAL`, `MAJOR`, `MINOR` or `INFO`.
 * @returns The visual defined in `robot-state-visuals.ts`.
 */
export function severityVisual(severity: AlertSeverity): AlertVisual {
  switch (severity) {
    case "CRITICAL":
      return ALERT_VISUALS.critical;
    case "MAJOR":
      return ALERT_VISUALS.major;
    case "MINOR":
      return ALERT_VISUALS.minor;
    case "INFO":
      return ALERT_VISUALS.info;
  }
}

/**
 * Writes the sentence of an alert, naming its robot, for example "sim-03 blocked".
 *
 * @param alert - The alert.
 * @param t - Translation function of the `alerts` namespace.
 * @returns The localised sentence.
 */
export function alertMessage(alert: AlertRecord, t: TFunction): string {
  return t(`kind.${alert.kind}`, { robot: alert.robotId });
}

/**
 * Names the user who acted on an alert: "you" for the signed-in user, otherwise an operator identified by the
 * last hex digits of the subject, so that no full identifier is shown.
 *
 * @param sub - Subject of the user who acted.
 * @param mySub - Subject of the signed-in user, or `null` when signed out.
 * @param t - Translation function of the `alerts` namespace.
 * @returns The localised name.
 */
export function actorLabel(sub: string, mySub: string | null, t: TFunction): string {
  if (mySub !== null && sub === mySub) {
    return t("you");
  }
  return t("operator", { id: sub.slice(-ACTOR_ID_LENGTH) });
}

/**
 * Chooses the alert the pill shows. Only open alerts count: an acknowledged alert no longer needs the first look.
 *
 * @param alerts - Active alerts, in any order.
 * @returns The most urgent, then newest, open Critical or Major alert, and how many there are.
 */
export function newestPillAlert(alerts: readonly AlertRecord[]): PillSummary {
  const urgent = alerts
    .filter(
      (alert) =>
        alert.status === "OPEN" && (alert.severity === "CRITICAL" || alert.severity === "MAJOR"),
    )
    .sort(compareAlerts);
  return { alert: urgent[0] ?? null, count: urgent.length };
}

/**
 * Tells whether an open Critical alert exists. While it does, the critical sound repeats.
 *
 * @param alerts - Active alerts, in any order.
 * @returns `true` when at least one alert is open with severity Critical.
 */
export function hasOpenCritical(alerts: readonly AlertRecord[]): boolean {
  return alerts.some((alert) => alert.status === "OPEN" && alert.severity === "CRITICAL");
}

/**
 * Groups alerts by severity, most urgent group first, each group in {@link compareAlerts} order.
 *
 * @param alerts - Alerts in any order.
 * @returns The non-empty groups.
 */
export function groupBySeverity(alerts: readonly AlertRecord[]): ReadonlyArray<{
  readonly severity: AlertSeverity;
  readonly alerts: readonly AlertRecord[];
}> {
  const sorted = [...alerts].sort(compareAlerts);
  return SEVERITY_ORDER.flatMap((severity) => {
    const group = sorted.filter((alert) => alert.severity === severity);
    return group.length === 0 ? [] : [{ severity, alerts: group }];
  });
}

/**
 * Orders resolved alerts newest first, by the time they were resolved.
 *
 * @param alerts - Resolved alerts, in any order.
 * @returns A new list, newest resolution first.
 */
export function newestResolvedFirst(alerts: readonly AlertRecord[]): readonly AlertRecord[] {
  const resolvedAt = (alert: AlertRecord): number => Date.parse(alert.resolvedAt ?? alert.openedAt);
  return [...alerts].sort((a, b) => resolvedAt(b) - resolvedAt(a));
}

/**
 * Tells whether a role may acknowledge and resolve alerts. The console only hides the buttons; the API checks
 * the token on every action.
 *
 * @param role - The user's role, or `null` when signed out.
 * @returns `true` for Operators and Admins.
 */
export function canActOnAlerts(role: Role | null): boolean {
  return role === "Operator" || role === "Admin";
}

/**
 * Chooses the message of a failed operator action. A conflict or a missing alert means the list is stale, and
 * the cache is refetched by the action hook; every other failure gets the generic message.
 *
 * @param error - The error the mutation failed with.
 * @returns The key of the message in the `alerts` namespace.
 */
export function actionErrorKey(error: unknown): AlertErrorKey {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "error.conflict";
    }
    if (error.status === 404) {
      return "error.notFound";
    }
  }
  return "error.action";
}
