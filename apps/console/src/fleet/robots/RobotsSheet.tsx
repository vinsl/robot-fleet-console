/**
 * The robot list of the console: a sheet with a search field, state and alert filters, and a table of the robots.
 * The filters are shared with the map. Opened from the dock, or with `/` and Ctrl/Cmd+K, which focus the search
 * field (`?focus=search`).
 *
 * The table is the list alternative of the map (DESIGN 5): every robot is reachable with the Tab key, and its
 * robot cell opens the robot page.
 */
import type * as React from "react";
import { useEffect, useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  RobotStateSchema,
  type AlertRecord,
  type AlertSeverity,
  type RobotId,
  type RobotState,
} from "@mfc/protocol";
import { useActiveAlerts } from "../../api/alerts";
import { StateChip } from "../../components/StateChip";
import { Sheet } from "../../layout/Sheet";
import { useDismiss } from "../../layout/use-dismiss";
import { formatDuration } from "../../lib/duration";
import { formatBattery } from "../../lib/format-battery";
import {
  useFleetFilterStore,
  isFilterActive,
  type FleetFilter,
} from "../../live/fleet-filter-store";
import type { FleetData } from "../../live/fleet-reducer";
import { useFleetStore } from "../../live/fleet-store";
import { useSelectionStore } from "../../live/selection-store";
import { useNow } from "../../live/use-now";
import { ALERT_VISUALS, BADGE_VISUALS } from "../../theme/robot-state-visuals";
import { tokens } from "../../theme/tokens";
import { useWsStore } from "../../ws/ws-store";
import { robotRows, type RobotRow } from "./robot-rows";
import styles from "./RobotsSheet.module.css";

/** Every robot state, in the order the state filter lists them. */
const ROBOT_STATES: readonly RobotState[] = RobotStateSchema.options;

/** Age below which the last-seen cell says "now" instead of a duration. */
const JUST_NOW_MS = 1_000;

/** Stable empty list, so that the memoised rows do not change while the alert query has no data. */
const NO_ALERTS: readonly AlertRecord[] = [];

/**
 * Typed lookup of an alert severity visual. A switch keeps the lookup on the closed union of the protocol.
 *
 * @param severity - The alert severity.
 * @returns The visual defined in `robot-state-visuals.ts`.
 */
function alertVisualOf(
  severity: AlertSeverity,
): (typeof ALERT_VISUALS)[keyof typeof ALERT_VISUALS] {
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

/** Props of {@link RobotRowCells}. */
interface RobotRowCellsProps {
  readonly row: RobotRow;
  readonly onOpen: (robotId: RobotId) => void;
}

/**
 * Renders the cells of one robot: the button to its page, state, battery, last seen and alert.
 *
 * @param props - The row and the open handler.
 * @returns The table row.
 */
function RobotRowCells({ row, onOpen }: RobotRowCellsProps): React.JSX.Element {
  const { t, i18n } = useTranslation("fleet");
  const { t: tCommon } = useTranslation("common");
  const { t: tStates } = useTranslation("states");
  const { view } = row;
  const robotId = view.robot.robotId;
  const lowBattery = view.badges.includes("lowBattery");
  const LowBatteryIcon = BADGE_VISUALS.lowBattery.icon;
  const alert = row.alertSeverity === null ? null : alertVisualOf(row.alertSeverity);
  return (
    <tr>
      <th scope="row" className={styles.robotCell}>
        <button
          type="button"
          className={styles.robotButton}
          aria-label={t("robots.open", { robot: robotId })}
          onClick={() => {
            onOpen(robotId);
          }}
        >
          {robotId}
        </button>
      </th>
      <td>
        <StateChip state={view.displayState} />
      </td>
      <td className={styles.numeric}>
        <span>
          {tCommon("percent", { value: formatBattery(view.robot.battery, i18n.language) })}
        </span>
        {lowBattery ? (
          <span className={styles.badge}>
            <LowBatteryIcon
              aria-hidden="true"
              focusable="false"
              className={styles.badgeIcon}
              style={{ color: BADGE_VISUALS.lowBattery.color }}
            />
            {tStates(BADGE_VISUALS.lowBattery.labelKey)}
          </span>
        ) : null}
      </td>
      <td className={styles.numeric}>
        {view.ageMs < JUST_NOW_MS ? t("robots.justNow") : formatDuration(view.ageMs, tCommon)}
      </td>
      <td>
        {alert === null ? null : (
          <span className={styles.badge} style={{ color: alert.color }}>
            <alert.icon aria-hidden="true" focusable="false" className={styles.badgeIcon} />
            {tStates(alert.labelKey)}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Renders the robot list sheet.
 *
 * @returns The sheet.
 */
export function RobotsSheet(): React.JSX.Element {
  const { t } = useTranslation("fleet");
  const { t: tShell } = useTranslation("shell");
  const dismiss = useDismiss();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const focusSearch = params.get("focus") === "search";
  const searchRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  // Actions are read with `getState()` in the handlers: the store declares them as methods, and only the filter
  // value is needed to render.
  const filter = useFleetFilterStore((state) => state.filter);
  const robots = useFleetStore((state) => state.robots);
  const session = useFleetStore((state) => state.session);
  const snapshotAt = useFleetStore((state) => state.snapshotAt);
  const droppedRobots = useFleetStore((state) => state.droppedRobots);
  const connectionOpen = useWsStore((state) => state.connection === "open");
  const now = useNow(tokens.live.nowTickMs);
  const alerts = useActiveAlerts().data ?? NO_ALERTS;

  const fleet = useMemo<FleetData>(
    () => ({ robots, session, snapshotAt, droppedRobots }),
    [robots, session, snapshotAt, droppedRobots],
  );
  const rows = useMemo(
    () => robotRows(fleet, now, connectionOpen, alerts, filter),
    [fleet, now, connectionOpen, alerts, filter],
  );
  const total = Object.keys(robots).length;
  const active = isFilterActive(filter);

  // Runs after the Sheet has moved focus to its first control, so the search field keeps the focus on arrival.
  // The location key is a dependency: a second `/` while the sheet is open is a new navigation to the same address.
  useEffect(() => {
    if (focusSearch) {
      searchRef.current?.focus();
    }
  }, [focusSearch, location.key]);

  const openRobot = (robotId: RobotId): void => {
    useSelectionStore.getState().requestFocus(robotId);
    void navigate(`/robots/${encodeURIComponent(robotId)}`);
  };

  const setFilter = (next: FleetFilter): void => {
    useFleetFilterStore.getState().setFilter(next);
  };

  const toggleState = (state: RobotState): void => {
    const included = filter.states.includes(state);
    setFilter({
      ...filter,
      states: ROBOT_STATES.filter((candidate) =>
        candidate === state ? !included : filter.states.includes(candidate),
      ),
    });
  };

  return (
    <Sheet title={t("robots.title")} onClose={dismiss}>
      <form
        role="search"
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className={styles.search}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("robots.search")}</span>
            <input
              ref={searchRef}
              type="search"
              className={styles.input}
              value={filter.text}
              aria-describedby={hintId}
              onChange={(event) => {
                setFilter({ ...filter, text: event.target.value });
              }}
            />
          </label>
          <span id={hintId} className={styles.hint}>
            {tShell("shortcut.search")}
          </span>
        </div>
        <fieldset className={styles.group}>
          <legend className={styles.fieldLabel}>{t("robots.filterState")}</legend>
          {ROBOT_STATES.map((state) => (
            <label key={state} className={styles.option}>
              <input
                type="checkbox"
                checked={filter.states.includes(state)}
                onChange={() => {
                  toggleState(state);
                }}
              />
              <StateChip state={state} />
            </label>
          ))}
        </fieldset>
        <fieldset className={styles.group}>
          <legend className="visually-hidden">{t("robots.filterOther")}</legend>
          <label className={styles.option}>
            <input
              type="checkbox"
              checked={filter.withAlert}
              onChange={(event) => {
                setFilter({ ...filter, withAlert: event.target.checked });
              }}
            />
            {t("robots.withAlert")}
          </label>
          <label className={styles.option}>
            <input
              type="checkbox"
              checked={filter.lowBattery}
              onChange={(event) => {
                setFilter({ ...filter, lowBattery: event.target.checked });
              }}
            />
            {t("robots.lowBattery")}
          </label>
        </fieldset>
        <button
          type="button"
          className={styles.clear}
          disabled={!active}
          onClick={() => {
            useFleetFilterStore.getState().clear();
            searchRef.current?.focus();
          }}
        >
          {t("robots.clear")}
        </button>
      </form>

      {total === 0 ? <p className={styles.message}>{t("robots.none")}</p> : null}
      {total > 0 && rows.length === 0 ? (
        <p className={styles.message}>{t("robots.empty")}</p>
      ) : null}
      {rows.length > 0 ? (
        <table className={styles.table}>
          <caption className={styles.caption}>
            {t("robots.count", { shown: rows.length, total })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("robots.col.robot")}</th>
              <th scope="col">{t("robots.col.state")}</th>
              <th scope="col">{t("robots.col.battery")}</th>
              <th scope="col">{t("robots.col.lastSeen")}</th>
              <th scope="col">{t("robots.col.alert")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RobotRowCells key={row.view.robot.robotId} row={row} onOpen={openRobot} />
            ))}
          </tbody>
        </table>
      ) : null}
    </Sheet>
  );
}
