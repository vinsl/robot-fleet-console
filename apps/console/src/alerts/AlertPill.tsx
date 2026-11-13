/**
 * The alert pill: a glass pill at the top centre of the map that shows the newest open Critical or Major alert,
 * or the number of such alerts. It is the first thing an operator reads when something stops.
 *
 * One alert gives its chip, sentence and age, and a View button that focuses the robot on the map. Several alerts
 * give their count and a button to the alerts sheet. An acknowledged alert no longer needs the first look, so it
 * does not raise the pill. Nothing is shown when no such alert is open.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useActiveAlerts } from "../api/alerts";
import { formatDuration } from "../lib/duration";
import { classNames } from "../lib/class-names";
import { useSelectionStore } from "../live/selection-store";
import { useNow } from "../live/use-now";
import { tokens } from "../theme/tokens";
import { AlertChip } from "./AlertChip";
import { alertMessage, newestPillAlert } from "./alert-text";
import styles from "./AlertPill.module.css";

/**
 * Renders the alert pill.
 *
 * @returns The pill, or `null` when no Critical or Major alert is open.
 */
export function AlertPill(): React.JSX.Element | null {
  const { t } = useTranslation("alerts");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  const now = useNow(tokens.live.nowTickMs);
  const query = useActiveAlerts();
  const { alert, count } = newestPillAlert(query.data ?? []);

  if (alert === null) {
    return null;
  }

  if (count > 1) {
    return (
      <div className={classNames("glass", styles.pill)}>
        <span className={styles.message}>{t("pill.count", { count })}</span>
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            void navigate("/alerts");
          }}
        >
          {t("pill.openSheet")}
        </button>
      </div>
    );
  }

  return (
    <div className={classNames("glass", styles.pill)}>
      <AlertChip severity={alert.severity} status={alert.status} />
      <span className={styles.message}>{alertMessage(alert, t)}</span>
      <span className={styles.age}>
        {t("openedAgo", { age: formatDuration(now - Date.parse(alert.openedAt), tCommon) })}
      </span>
      <button
        type="button"
        className={styles.action}
        onClick={() => {
          useSelectionStore.getState().requestFocus(alert.robotId);
          void navigate(`/robots/${alert.robotId}`);
        }}
      >
        {t("pill.view")}
      </button>
    </div>
  );
}
