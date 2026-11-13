/**
 * The permanent banner of the demo mode. It is visible on every page while the mode is on, so that nobody mistakes
 * simulated faults for real ones.
 *
 * It is neutral on purpose (DESIGN 3.6): the banner never competes with an alert for attention.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { useDemoEnabled } from "./use-demo";
import styles from "./DemoBanner.module.css";

/**
 * Renders the banner when the demo mode is on, and nothing otherwise.
 *
 * @returns The banner, or `null` while the mode is off.
 */
export function DemoBanner(): React.JSX.Element | null {
  const { t } = useTranslation("demo");
  const enabled = useDemoEnabled();
  if (!enabled) {
    return null;
  }
  return (
    <div className={styles.banner}>
      <FlaskConical aria-hidden="true" focusable="false" className={styles.icon} />
      <strong className={styles.label}>{t("banner")}</strong>
      <span className={styles.detail}>{t("detail")}</span>
    </div>
  );
}
