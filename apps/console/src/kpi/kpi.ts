/**
 * The fleet KPIs, defined once here (ADR 0059). Every function is pure: it takes the live fleet, the clock, the
 * connection state and the alert lists, and returns the value, or `null` when the value cannot be computed yet.
 *
 * Two windows apply. Missions per hour and the error rate only cover the time since the console opened: the
 * console has no history of missions before that, and the session log keeps 60 minutes at most. Interventions
 * and MTTR read the alert history of the last 24 hours.
 *
 * @module kpi/kpi
 */
import type { AlertRecord, RobotState } from "@mfc/protocol";
import { robotView } from "../live/fleet-selectors";
import type { FleetData } from "../live/fleet-reducer";
import { live } from "../theme/tokens";

/** Milliseconds in one minute, for the minute counts shown in the UI. */
const MS_PER_MINUTE = 60_000;

/** Milliseconds in one hour, the unit of missions per hour. */
const MS_PER_HOUR = 3_600_000;

/** States that count against availability: the robot cannot take work. */
const UNAVAILABLE_STATES: ReadonlySet<RobotState> = new Set<RobotState>([
  "OFFLINE",
  "BLOCKED",
  "ESTOP",
]);

/** Everything a KPI is computed from. */
export interface KpiInputs {
  /** The live fleet, with the session log. */
  readonly fleet: FleetData;
  /** Client time in milliseconds. */
  readonly now: number;
  /** Whether the realtime connection is open. */
  readonly connectionOpen: boolean;
  /** Active alerts: open and acknowledged. */
  readonly active: readonly AlertRecord[];
  /** Resolved alerts, from the history window (first page only). */
  readonly resolved: readonly AlertRecord[];
}

/** Missions per hour and the counts it rests on. */
export interface MissionsPerHour {
  /** Missions per hour, or `null` before the warm-up window has passed. */
  readonly perHour: number | null;
  /** Missions completed in the window. */
  readonly count: number;
  /** Length of the window in whole minutes (shorter than 60 during the first hour). */
  readonly minutes: number;
}

/** Every KPI of the sheet, computed together. */
export interface KpiValues {
  readonly availability: number | null;
  readonly missions: MissionsPerHour;
  readonly errorRate: number | null;
  readonly interventions: number | null;
  readonly mttrMs: number | null;
}

/**
 * Share of known robots whose displayed state is not OFFLINE, BLOCKED or ESTOP, now.
 *
 * @param i - The KPI inputs.
 * @returns A value between 0 and 1, or `null` when no robot is known or the connection is closed.
 */
export function availability(i: KpiInputs): number | null {
  const robots = Object.values(i.fleet.robots);
  if (!i.connectionOpen || robots.length === 0) {
    return null;
  }
  const available = robots.filter(
    (robot) => !UNAVAILABLE_STATES.has(robotView(robot, i.now, true).displayState),
  ).length;
  return available / robots.length;
}

/**
 * Missions completed in the last `min(60 min, session age)`, per hour. Before the warm-up window the rate would
 * be extrapolated from a few seconds, so it is withheld.
 *
 * @param i - The KPI inputs.
 * @returns The rate (null during warm-up), the count and the window length in minutes.
 */
export function missionsPerHour(i: KpiInputs): MissionsPerHour {
  const window = sessionWindow(i);
  const count = countSince(i.fleet.session.missionsDone, window.cutoff);
  const minutes = Math.floor(window.ms / MS_PER_MINUTE);
  if (window.ageMs < live.kpiWarmupMs) {
    return { perHour: null, count, minutes };
  }
  return { perHour: count / (window.ms / MS_PER_HOUR), count, minutes };
}

/**
 * Blocks and e-stops over the missions and the blocks and e-stops of the session window.
 *
 * @param i - The KPI inputs.
 * @returns A value between 0 and 1, or `null` when the session has no mission and no stop yet.
 */
export function errorRate(i: KpiInputs): number | null {
  const window = sessionWindow(i);
  const missions = countSince(i.fleet.session.missionsDone, window.cutoff);
  const stops = countSince(i.fleet.session.stops, window.cutoff);
  const total = missions + stops;
  return total === 0 ? null : stops / total;
}

/**
 * Alerts acknowledged in the last 24 hours, per known robot. An alert that was acknowledged and then resolved
 * still counts once.
 *
 * @param i - The KPI inputs.
 * @returns The ratio, or `null` when no robot is known.
 */
export function interventionsPerRobot(i: KpiInputs): number | null {
  const robotCount = Object.keys(i.fleet.robots).length;
  if (robotCount === 0) {
    return null;
  }
  const cutoff = i.now - live.historyWindowMs;
  const acknowledged = uniqueAlerts(i).filter(
    (alert) => alert.acknowledgedAt !== undefined && Date.parse(alert.acknowledgedAt) >= cutoff,
  );
  return acknowledged.length / robotCount;
}

/**
 * Mean time from opening to resolution, over the alerts resolved in the last 24 hours.
 *
 * @param i - The KPI inputs.
 * @returns The mean in milliseconds, or `null` when no alert was resolved in the window.
 */
export function mttrMs(i: KpiInputs): number | null {
  const cutoff = i.now - live.historyWindowMs;
  const durations: number[] = [];
  for (const alert of uniqueAlerts(i)) {
    if (alert.resolvedAt === undefined) {
      continue;
    }
    const resolvedAt = Date.parse(alert.resolvedAt);
    if (resolvedAt >= cutoff) {
      // Clamped: clock skew between robot and cloud must not yield a negative repair time.
      durations.push(Math.max(0, resolvedAt - Date.parse(alert.openedAt)));
    }
  }
  if (durations.length === 0) {
    return null;
  }
  return durations.reduce((sum, value) => sum + value, 0) / durations.length;
}

/**
 * Computes every KPI of the sheet from one set of inputs.
 *
 * @param i - The KPI inputs.
 * @returns The values.
 */
export function computeKpis(i: KpiInputs): KpiValues {
  return {
    availability: availability(i),
    missions: missionsPerHour(i),
    errorRate: errorRate(i),
    interventions: interventionsPerRobot(i),
    mttrMs: mttrMs(i),
  };
}

/**
 * Formats a ratio as a percentage in the UI language, without decimals. Callers test for `null` first and show
 * the "no data" text instead.
 *
 * @param value - A ratio between 0 and 1.
 * @param locale - The UI language.
 * @returns The formatted percentage.
 */
export function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    value,
  );
}

/** A formatted number split from its unit, so the sheet can set the unit in secondary text. */
export interface NumberParts {
  /** The digits, without any literal whitespace. */
  readonly number: string;
  /** The unit, such as `%`. Empty when the locale has none. */
  readonly unit: string;
}

/**
 * Formats a ratio as a percentage and splits the percent sign from the digits. The literal space that some
 * locales put before the sign (the French narrow no-break space) is dropped, so the unit sits against the
 * digits in every language.
 *
 * @param value - A ratio between 0 and 1.
 * @param locale - The UI language.
 * @returns The digits and the percent sign.
 */
export function percentParts(value: number, locale: string): NumberParts {
  const parts = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).formatToParts(value);
  const number = parts
    .filter((part) => part.type !== "percentSign" && part.type !== "literal")
    .map((part) => part.value)
    .join("");
  const unit = parts
    .filter((part) => part.type === "percentSign")
    .map((part) => part.value)
    .join("");
  return { number, unit };
}

/**
 * Formats a decimal value (missions per hour, interventions per robot) with at most one decimal.
 *
 * @param value - The value.
 * @param locale - The UI language.
 * @returns The formatted number.
 */
export function formatDecimal(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/**
 * Describes the window the session KPIs cover: the session age, the window length and its start.
 *
 * @param i - The KPI inputs.
 * @returns The age of the session, the window length and the cut-off time.
 */
function sessionWindow(i: KpiInputs): {
  readonly ageMs: number;
  readonly ms: number;
  readonly cutoff: number;
} {
  const ageMs = Math.max(0, i.now - i.fleet.session.startedAt);
  const ms = Math.min(live.sessionWindowMs, ageMs);
  return { ageMs, ms, cutoff: i.now - ms };
}

/**
 * Counts the session timestamps at or after a cut-off.
 *
 * @param times - Session timestamps in milliseconds.
 * @param cutoff - The first instant that counts.
 * @returns The number of timestamps at or after the cut-off.
 */
function countSince(times: readonly number[], cutoff: number): number {
  return times.filter((time) => time >= cutoff).length;
}

/**
 * Merges the active and resolved lists by alert identifier. The resolved entry wins: it is the newer state of
 * an alert that appears in both lists during a refetch.
 *
 * @param i - The KPI inputs.
 * @returns One record per alert.
 */
function uniqueAlerts(i: KpiInputs): readonly AlertRecord[] {
  const byId = new Map<string, AlertRecord>();
  for (const alert of [...i.active, ...i.resolved]) {
    byId.set(alert.alertId, alert);
  }
  return [...byId.values()];
}
