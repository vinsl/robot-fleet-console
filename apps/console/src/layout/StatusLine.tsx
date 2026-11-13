/**
 * Status line at the top of the console: site clock, realtime connection, API health, robots online, open alerts,
 * role, alert sound, language and account menu. It has no surface of its own: it sits on a scrim so the map stays
 * readable. On a compact screen (ADR 0075) it keeps the site name, the connection icon and the alert count (DESIGN 2.4).
 */
import type * as React from "react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import type { Role } from "@mfc/protocol";
import type { ApiHealth } from "../api/health";
import { classNames } from "../lib/class-names";
import { CONNECTION_VISUALS } from "../theme/robot-state-visuals";
import type { WsState } from "../ws/ws-client";
import { connectionStatusOf, type ConnectionStatus } from "./connection";
import { LanguageSwitch } from "./LanguageSwitch";
import { SoundToggle } from "./SoundToggle";
import { UserMenu } from "./UserMenu";
import styles from "./StatusLine.module.css";

/** Interval of the clock. A minute is the finest step the display shows. */
const CLOCK_TICK_MS = 30_000;

/** Props of {@link StatusLine}. */
export interface StatusLineProps {
  /** Realtime connection state. */
  readonly ws: WsState;
  /** Latest API health result. */
  readonly api: ApiHealth;
  /** Robots currently online, or `null` while no fleet data is known. */
  readonly robotsOnline: number | null;
  /** Open alerts, or `null` while the alert list is not known. Shown on a compact screen, where the dock is icons only. */
  readonly openAlerts: number | null;
  /** The user's role, or `null` when the user has no known group. */
  readonly role: Role | null;
}

/**
 * Keeps the current time, refreshed every {@link CLOCK_TICK_MS}, formatted for the UI language.
 *
 * @param language - The UI language, used for the format.
 * @returns The date and the formatted time.
 */
function useClock(language: string): { readonly now: Date; readonly text: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const text = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
    now,
  );
  return { now, text };
}

/**
 * Typed lookup of a connection visual. A switch keeps the lookup on a closed union, so no computed key reaches
 * the table.
 *
 * @param status - The connection status.
 * @returns The visual defined in `robot-state-visuals.ts`.
 */
function connectionVisualOf(
  status: ConnectionStatus,
): (typeof CONNECTION_VISUALS)[ConnectionStatus] {
  switch (status) {
    case "live":
      return CONNECTION_VISUALS.live;
    case "reconnecting":
      return CONNECTION_VISUALS.reconnecting;
    case "offline":
      return CONNECTION_VISUALS.offline;
  }
}

/**
 * CSS class that paints a connection status with its state token (`--state-*`). The colour itself is in
 * `StatusLine.module.css`; the shape and the text carry the meaning too.
 *
 * @param status - The connection status.
 * @returns The class name.
 */
function colorClassOf(status: ConnectionStatus): string | undefined {
  switch (status) {
    case "live":
      return styles.live;
    case "reconnecting":
      return styles.reconnecting;
    case "offline":
      return styles.offline;
  }
}

/**
 * Connection indicator. It is a focusable status region named by its state, so a screen reader announces the
 * state and a keyboard user can reach the API latency tooltip, which is linked with `aria-describedby`.
 *
 * @param props - The realtime state and the API health.
 * @returns The indicator.
 */
function ConnectionIndicator({
  ws,
  api,
}: {
  readonly ws: WsState;
  readonly api: ApiHealth;
}): React.JSX.Element {
  const { t } = useTranslation("shell");
  const tooltipId = useId();
  const status = connectionStatusOf(ws);
  const visual = connectionVisualOf(status);
  const colorClass = colorClassOf(status);
  const Icon = visual.icon;
  const label = t(visual.labelKey, { ns: "states" });
  const apiText =
    api.ok && api.latencyMs !== null
      ? t("status.apiLatency", { ms: api.latencyMs })
      : t("status.apiDown");

  return (
    <span
      className={styles.connection}
      role="status"
      tabIndex={0}
      aria-label={t("status.connection", { state: label })}
      aria-describedby={tooltipId}
    >
      <Icon aria-hidden="true" focusable="false" className={classNames(styles.icon, colorClass)} />
      <span className={classNames(colorClass, styles.connectionText)}>{label}</span>
      <span role="tooltip" id={tooltipId} className={styles.tooltip}>
        {apiText}
      </span>
    </span>
  );
}

/**
 * Renders the status line.
 *
 * @param props - Connection, API health, robots online, open alerts, role.
 * @returns The status line.
 */
export function StatusLine({
  ws,
  api,
  robotsOnline,
  openAlerts,
  role,
}: StatusLineProps): React.JSX.Element {
  const { t, i18n } = useTranslation("shell");
  const clock = useClock(i18n.resolvedLanguage ?? "en");
  const robots =
    robotsOnline === null
      ? t("status.robotsUnknown")
      : t("status.robotsOnline", { count: robotsOnline });
  const showsAlerts = openAlerts !== null && openAlerts > 0;

  return (
    <header className={styles.line}>
      <span className={styles.brand}>{t("app.name", { ns: "common" })}</span>
      <time className={styles.clock} dateTime={clock.now.toISOString()}>
        {clock.text}
      </time>
      <ConnectionIndicator ws={ws} api={api} />
      {showsAlerts ? (
        <span className={classNames(styles.alerts, styles.phoneOnly)}>
          <Bell aria-hidden="true" focusable="false" className={styles.icon} />
          {t("dockCount", { ns: "alerts", count: openAlerts })}
        </span>
      ) : null}
      <span className={styles.robots}>{robots}</span>
      <span className={styles.role}>{t(`role.${role ?? "none"}`)}</span>
      <div className={styles.end}>
        <SoundToggle />
        <LanguageSwitch />
        <UserMenu />
      </div>
    </header>
  );
}
