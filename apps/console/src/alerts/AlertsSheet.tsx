/**
 * The alerts sheet: the active alerts grouped by severity, and the alerts resolved in the last 24 hours.
 *
 * Operators and Admins acknowledge and resolve from here; Viewers read only, and are told so. The tabs follow the
 * tab pattern: arrow keys move between them, Home and End jump to the ends, and only the selected tab is in the
 * tab order. Order is always the urgency order of {@link compareAlerts}, whatever order the API used.
 */
import type * as React from "react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertRecord, AlertSeverity } from "@mfc/protocol";
import { useActiveAlerts, useResolvedAlerts } from "../api/alerts";
import { useAuthStore } from "../auth/auth-store";
import { Sheet } from "../layout/Sheet";
import { useDismiss } from "../layout/use-dismiss";
import { useNow } from "../live/use-now";
import { tokens } from "../theme/tokens";
import { AlertRow } from "./AlertRow";
import { canActOnAlerts, groupBySeverity, newestResolvedFirst, severityVisual } from "./alert-text";
import styles from "./AlertsSheet.module.css";

/** The tabs of the sheet, in display order. */
type TabId = "active" | "history";

/** Tabs in display order, used by the keyboard handler. */
const TABS: readonly TabId[] = ["active", "history"];

/** Value of a filter that lets every alert through. */
const ALL = "ALL";

/** Severities offered by the severity filter, most urgent first. */
const SEVERITIES: readonly AlertSeverity[] = ["CRITICAL", "MAJOR", "MINOR", "INFO"];

/**
 * Computes the tab that a key moves to. With two tabs, the arrows both toggle; Home and End jump to the ends.
 *
 * @param current - The tab that has the focus.
 * @param key - The key pressed.
 * @returns The tab to select, or `null` when the key is not a tab navigation key.
 */
function tabForKey(current: TabId, key: string): TabId | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowLeft":
      return current === "active" ? "history" : "active";
    case "Home":
      return "active";
    case "End":
      return "history";
    default:
      return null;
  }
}

/**
 * Renders the alerts sheet.
 *
 * @returns The sheet.
 */
export function AlertsSheet(): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const dismiss = useDismiss();
  const role = useAuthStore((state) => state.role);
  const now = useNow(tokens.live.nowTickMs);
  const [tab, setTab] = useState<TabId>("active");
  const idPrefix = useId();
  const tabButtons = useRef(new Map<TabId, HTMLButtonElement>());

  const tabId = (id: TabId): string => `${idPrefix}-tab-${id}`;
  const panelId = (id: TabId): string => `${idPrefix}-panel-${id}`;

  /**
   * Selects a tab and moves the focus to it, as the tab pattern asks for arrow navigation.
   *
   * @param next - The tab to select.
   */
  const select = (next: TabId): void => {
    setTab(next);
    tabButtons.current.get(next)?.focus();
  };

  return (
    <Sheet title={t("title")} onClose={dismiss}>
      {canActOnAlerts(role) ? null : <p className={styles.note}>{t("readOnly")}</p>}
      <div role="tablist" aria-label={t("title")} className={styles.tabs}>
        {TABS.map((id) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              ref={(element) => {
                if (element !== null) {
                  tabButtons.current.set(id, element);
                }
              }}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={selected}
              aria-controls={panelId(id)}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => {
                setTab(id);
              }}
              onKeyDown={(event) => {
                const next = tabForKey(id, event.key);
                if (next !== null) {
                  event.preventDefault();
                  select(next);
                }
              }}
            >
              {t(`tabs.${id}`)}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} className={styles.panel}>
        {tab === "active" ? <ActivePanel now={now} /> : <HistoryPanel now={now} />}
      </div>
    </Sheet>
  );
}

/** Props of the panels. */
interface PanelProps {
  /** Current time, shared by every age in the panel. */
  readonly now: number;
}

/**
 * Shows the error of a list with a retry button. The message names the failure; the retry refetches.
 *
 * @param props - The retry handler.
 * @returns The alert region.
 */
function LoadFailure({ onRetry }: { readonly onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const { t: tFleet } = useTranslation("fleet");
  return (
    <div role="alert" className={styles.failure}>
      <p>{t("error.load")}</p>
      <button type="button" className={styles.button} onClick={onRetry}>
        {tFleet("map.retry")}
      </button>
    </div>
  );
}

/**
 * The active tab: filters by severity and robot, then one group per severity.
 *
 * @param props - The current time.
 * @returns The panel content.
 */
function ActivePanel({ now }: PanelProps): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const { t: tStates } = useTranslation("states");
  const query = useActiveAlerts();
  const [severity, setSeverity] = useState<AlertSeverity | typeof ALL>(ALL);
  const [robot, setRobot] = useState<string>(ALL);
  const severityFilterId = useId();
  const robotFilterId = useId();

  const alerts = query.data;
  if (alerts === undefined) {
    return query.isError ? (
      <LoadFailure
        onRetry={() => {
          void query.refetch();
        }}
      />
    ) : (
      <p role="status">{t("loading")}</p>
    );
  }

  const robots = [...new Set(alerts.map((alert) => alert.robotId))].sort();
  // A robot that left the list no longer exists as a choice: the filter falls back to every robot.
  const selectedRobot = robot === ALL || robots.includes(robot) ? robot : ALL;
  const visible = alerts.filter(
    (alert) =>
      (severity === ALL || alert.severity === severity) &&
      (selectedRobot === ALL || alert.robotId === selectedRobot),
  );
  const groups = groupBySeverity(visible);

  return (
    <>
      <div className={styles.filters}>
        <label htmlFor={severityFilterId}>{t("filter.severity")}</label>
        <select
          id={severityFilterId}
          className={styles.select}
          value={severity}
          onChange={(event) => {
            setSeverity(SEVERITIES.find((value) => value === event.target.value) ?? ALL);
          }}
        >
          <option value={ALL}>{t("filter.all")}</option>
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {tStates(severityVisual(value).labelKey)}
            </option>
          ))}
        </select>
        <label htmlFor={robotFilterId}>{t("filter.robot")}</label>
        <select
          id={robotFilterId}
          className={styles.select}
          value={selectedRobot}
          onChange={(event) => {
            setRobot(event.target.value);
          }}
        >
          <option value={ALL}>{t("filter.all")}</option>
          {robots.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      {groups.length === 0 ? <p>{t("empty.active")}</p> : null}
      {groups.map((group) => (
        <SeverityGroup
          key={group.severity}
          severity={group.severity}
          alerts={group.alerts}
          now={now}
        />
      ))}
    </>
  );
}

/** Props of {@link SeverityGroup}. */
interface SeverityGroupProps extends PanelProps {
  /** Severity of the group. */
  readonly severity: AlertSeverity;
  /** Alerts of the group, in display order. */
  readonly alerts: readonly AlertRecord[];
}

/**
 * One severity group of the active list: a heading named by the severity, then its alerts.
 *
 * @param props - The group.
 * @returns The section.
 */
function SeverityGroup({ severity, alerts, now }: SeverityGroupProps): React.JSX.Element {
  const { t } = useTranslation("states");
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.group}>
      <h3 id={headingId} className={styles.heading}>
        {t(severityVisual(severity).labelKey)}
      </h3>
      <ul className={styles.list}>
        {alerts.map((alert) => (
          <AlertRow key={alert.alertId} alert={alert} now={now} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The history tab: alerts resolved in the window, newest resolution first, with "Load more" while the API has a
 * next page.
 *
 * @param props - The current time.
 * @returns The panel content.
 */
function HistoryPanel({ now }: PanelProps): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const query = useResolvedAlerts();
  const data = query.data;
  if (data === undefined) {
    return query.isError ? (
      <LoadFailure
        onRetry={() => {
          void query.refetch();
        }}
      />
    ) : (
      <p role="status">{t("loading")}</p>
    );
  }

  const alerts = newestResolvedFirst(data.pages.flatMap((page) => page.alerts));
  return (
    <>
      {alerts.length === 0 ? <p>{t("empty.history")}</p> : null}
      {alerts.length === 0 ? null : (
        <ul className={styles.list}>
          {alerts.map((alert) => (
            <AlertRow key={alert.alertId} alert={alert} now={now} />
          ))}
        </ul>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          className={styles.button}
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {t("loadMore")}
        </button>
      ) : null}
    </>
  );
}
