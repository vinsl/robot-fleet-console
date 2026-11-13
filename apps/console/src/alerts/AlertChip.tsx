/**
 * Lifecycle chip of an alert: severity and status as an icon and a text, never as a colour alone (WCAG 1.4.1).
 *
 * An open alert is a filled chip, an acknowledged one an outlined chip in the severity colour, and a resolved one
 * a grey chip with a check. The shape and the icon carry the state; the colour only repeats it.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type { AlertSeverity, AlertStatus } from "@mfc/protocol";
import { classNames } from "../lib/class-names";
import { ALERT_RESOLVED_VISUAL } from "../theme/robot-state-visuals";
import { severityVisual } from "./alert-text";
import styles from "./AlertChip.module.css";

/** Props of {@link AlertChip}. */
export interface AlertChipProps {
  /** Severity of the alert. */
  readonly severity: AlertSeverity;
  /** Lifecycle status of the alert. */
  readonly status: AlertStatus;
}

/**
 * Renders the lifecycle chip of an alert.
 *
 * @param props - Severity and status.
 * @returns The chip.
 */
export function AlertChip({ severity, status }: AlertChipProps): React.JSX.Element {
  const { t } = useTranslation("states");

  if (status === "RESOLVED") {
    const Icon = ALERT_RESOLVED_VISUAL.icon;
    return (
      <span className={classNames(styles.chip, styles.resolved)}>
        <Icon aria-hidden="true" focusable="false" className={styles.icon} />
        <span>{t(ALERT_RESOLVED_VISUAL.labelKey)}</span>
      </span>
    );
  }

  const visual = severityVisual(severity);
  const Icon = visual.icon;
  const isOpen = status === "OPEN";
  return (
    <span
      className={classNames(styles.chip, isOpen ? styles.open : styles.acknowledged)}
      style={
        isOpen
          ? { backgroundColor: visual.color }
          : { color: visual.color, borderColor: visual.color }
      }
    >
      <Icon aria-hidden="true" focusable="false" className={styles.icon} />
      <span>{t(visual.labelKey)}</span>
    </span>
  );
}
