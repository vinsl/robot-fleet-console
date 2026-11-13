/**
 * The count of open alerts shown by the dock and the status line. An acknowledged alert is no longer open: it
 * still needs a resolution, but nobody has to look at it first, so it is not counted.
 */
import type { AlertRecord } from "@mfc/protocol";
import { useActiveAlerts } from "../api/alerts";

/**
 * Counts the alerts whose status is `OPEN`.
 *
 * @param alerts - Active alerts (open and acknowledged).
 * @returns The number of open alerts.
 */
export function countOpenAlerts(alerts: readonly AlertRecord[]): number {
  return alerts.filter((alert) => alert.status === "OPEN").length;
}

/**
 * Reads the open-alert count from the active alert list.
 *
 * @returns The count, or `null` while the list is loading or unavailable, so that no misleading zero is shown.
 */
export function useOpenAlertCount(): number | null {
  const { data } = useActiveAlerts();
  return data === undefined ? null : countOpenAlerts(data);
}
