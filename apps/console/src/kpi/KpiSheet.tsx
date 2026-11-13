/**
 * The KPI sheet: the five fleet indicators, grouped by the time window they cover. The values are computed in the
 * console from the live stream and the alert history (ADR 0059); no chart is drawn (DESIGN.md, KPI row).
 *
 * The session group (availability, missions per hour, error rate) is labelled with the time the console opened,
 * since the console has no earlier data. The 24-hour group (interventions, MTTR) carries the note that the alert
 * history is incomplete when it is. The two hero KPIs of FR-KPI-1 come first, with the larger number size (ADR 0078).
 *
 * @module kpi/KpiSheet
 */
import type * as React from "react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { classNames } from "../lib/class-names";
import { Sheet } from "../layout/Sheet";
import { useDismiss } from "../layout/use-dismiss";
import { formatDuration } from "../lib/duration";
import { live } from "../theme/tokens";
import { formatDecimal, percentParts } from "./kpi";
import { useKpis } from "./use-kpis";
import styles from "./KpiSheet.module.css";

/** The dash shown in place of a value that cannot be computed yet. It is hidden from assistive technology. */
const NO_VALUE_GLYPH = "—";

/** Props of the card of one KPI. */
interface KpiCardProps {
  /** Translated label, also the heading of the card. */
  readonly label: string;
  /** Formatted value without its unit, or `null` when the value cannot be computed yet. */
  readonly value: string | null;
  /** Translated unit, shown in secondary text after the value. */
  readonly unit?: string | undefined;
  /** Translated definition of the KPI, or the warm-up hint while the value is withheld. */
  readonly hint: string;
  /** `true` for the two hero KPIs, which use the large number size. */
  readonly hero?: boolean;
  /** Translated line shown under the card, used for the no-data text; `null` shows nothing. */
  readonly noteText?: string | null;
}

/** Props of a group of cards that share one time window. */
interface KpiGroupProps {
  /** Translated heading of the group, naming the time window. */
  readonly title: string;
  /** Translated note for the whole group, or `null` when there is none. */
  readonly note?: string | null;
  /** The cards of the group. */
  readonly children: React.ReactNode;
}

/**
 * Renders one KPI: label, big value with its unit, definition and, when there is no value, the no-data line.
 *
 * @param props - The texts and the value of the card.
 * @returns The card, named by its label.
 */
function KpiCard({
  label,
  value,
  unit,
  hint,
  hero = false,
  noteText = null,
}: KpiCardProps): React.JSX.Element {
  const headingId = useId();
  const valueClass = classNames(styles.value, hero && styles.hero);
  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h4 id={headingId} className={styles.label}>
        {label}
      </h4>
      {value === null ? (
        // The visible no-data line below carries the meaning; the dash alone would read as a number.
        <p className={valueClass} aria-hidden="true">
          {NO_VALUE_GLYPH}
        </p>
      ) : (
        <p className={valueClass}>
          {value}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </p>
      )}
      <p className={styles.hint}>{hint}</p>
      {noteText ? <p className={styles.partial}>{noteText}</p> : null}
    </section>
  );
}

/**
 * Renders a group of KPI cards under one heading, with an optional note.
 *
 * @param props - The heading, the note and the cards.
 * @returns The group, named by its heading.
 */
function KpiGroup({ title, note = null, children }: KpiGroupProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.groupTitle}>
        {title}
      </h3>
      {note ? (
        <p role="note" className={styles.partial}>
          {note}
        </p>
      ) : null}
      <div className={styles.cards}>{children}</div>
    </section>
  );
}

/**
 * Renders the KPI sheet.
 *
 * @returns The sheet.
 */
export function KpiSheet(): React.JSX.Element {
  const { t, i18n } = useTranslation("kpi");
  const { t: tCommon } = useTranslation("common");
  const dismiss = useDismiss();
  const { values, partial, sessionStartedAt } = useKpis();
  const locale = i18n.language;
  const sessionTime = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(sessionStartedAt);
  const noData = t("noData");
  const { missions } = values;
  const availability =
    values.availability === null ? null : percentParts(values.availability, locale);
  const errorRate = values.errorRate === null ? null : percentParts(values.errorRate, locale);

  // During warm-up the count is shown instead of the rate, and the hint says when the rate appears. The warm-up
  // length is the real constant, so the text stays true if the constant changes.
  const missionsCard =
    missions.perHour === null
      ? {
          value: formatDecimal(missions.count, locale),
          unit: t("missions.warmingUnit", { minutes: missions.minutes }),
          hint: t("missions.warmingHint", { minutes: live.kpiWarmupMs / 60_000 }),
        }
      : {
          value: formatDecimal(missions.perHour, locale),
          unit: t("missions.unit"),
          hint: t("missions.hint"),
        };

  return (
    <Sheet title={t("title")} onClose={dismiss}>
      <KpiGroup title={t("group.session", { time: sessionTime })}>
        <KpiCard
          label={t("availability.label")}
          value={availability?.number ?? null}
          unit={availability?.unit}
          hint={t("availability.hint")}
          hero
          noteText={availability === null ? noData : null}
        />
        <KpiCard
          label={t("missions.label")}
          value={missionsCard.value}
          unit={missionsCard.unit}
          hint={missionsCard.hint}
          hero
        />
        <KpiCard
          label={t("errorRate.label")}
          value={errorRate?.number ?? null}
          unit={errorRate?.unit}
          hint={t("errorRate.hint")}
          noteText={errorRate === null ? noData : null}
        />
      </KpiGroup>
      <KpiGroup title={t("group.day")} note={partial ? t("partial") : null}>
        <KpiCard
          label={t("interventions.label")}
          value={values.interventions === null ? null : formatDecimal(values.interventions, locale)}
          hint={t("interventions.hint")}
          noteText={values.interventions === null ? noData : null}
        />
        <KpiCard
          label={t("mttr.label")}
          value={values.mttrMs === null ? null : formatDuration(values.mttrMs, tCommon)}
          hint={t("mttr.hint")}
          noteText={values.mttrMs === null ? noData : null}
        />
      </KpiGroup>
    </Sheet>
  );
}
