/**
 * The two KPI corners at the bottom of the map: availability on the left, missions per hour on the right. Each
 * is a link to the KPI sheet. Compact screens hide them (ADR 0075); the KPI page of the dock still shows the numbers.
 *
 * The values come from {@link useKpis}; the corners show "no data" rather than a misleading zero while a value
 * cannot be computed yet.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { classNames } from "../lib/class-names";
import { formatDecimal, formatPercent } from "./kpi";
import { useKpis } from "./use-kpis";
import styles from "./KpiCorners.module.css";

/**
 * Renders the KPI corners.
 *
 * @returns The corners, both as links to the KPI sheet.
 */
export function KpiCorners(): React.JSX.Element {
  const { t, i18n } = useTranslation("kpi");
  const { values } = useKpis();
  const locale = i18n.language;

  const availabilityText =
    values.availability === null ? t("noData") : formatPercent(values.availability, locale);
  const { missions } = values;
  const missionsText =
    missions.perHour === null
      ? t("missions.warming", { count: missions.count, minutes: missions.minutes })
      : formatDecimal(missions.perHour, locale);

  return (
    <nav aria-label={t("title")} className={styles.corners}>
      <Link to="/kpi" className={classNames(styles.corner, styles.left)}>
        <span className={styles.label}>{t("availability.label")}</span>
        <span className={styles.value}>{availabilityText}</span>
      </Link>
      <Link to="/kpi" className={classNames(styles.corner, styles.right)}>
        <span className={styles.label}>{t("missions.label")}</span>
        <span className={styles.value}>{missionsText}</span>
      </Link>
    </nav>
  );
}
