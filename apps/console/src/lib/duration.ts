/**
 * Human duration formatting for the live views (time since a stop, session age, time to resolve).
 *
 * The words come from the `common` namespace, so the formatting follows the chosen language. Minutes are
 * zero-padded only in the hours form (`2 h 05 min`), where the padding keeps the column readable.
 */
import type { TFunction } from "i18next";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;

/**
 * Formats a non-negative duration as seconds, minutes, or hours and minutes.
 *
 * Keys used: `duration.seconds` (`{{count}} s`), `duration.minutes` (`{{count}} min`) and
 * `duration.hoursMinutes` (`{{hours}} h {{minutes}} min`).
 *
 * @param ms - The duration in milliseconds. Fractions are truncated.
 * @param t - Translation function of the `common` namespace.
 * @returns The formatted duration, for example `12 s`, `3 min` or `2 h 05 min`.
 * @throws {RangeError} When `ms` is not a finite number.
 */
export function formatDuration(ms: number, t: TFunction): string {
  if (!Number.isFinite(ms)) {
    throw new RangeError(`duration must be a finite number, got ${String(ms)}`);
  }
  const total = Math.max(0, Math.floor(ms));
  if (total < MS_PER_MINUTE) {
    return t("duration.seconds", { count: Math.floor(total / MS_PER_SECOND) });
  }
  if (total < MS_PER_HOUR) {
    return t("duration.minutes", { count: Math.floor(total / MS_PER_MINUTE) });
  }
  const hours = Math.floor(total / MS_PER_HOUR);
  const minutes = Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE);
  return t("duration.hoursMinutes", { hours, minutes: String(minutes).padStart(2, "0") });
}
