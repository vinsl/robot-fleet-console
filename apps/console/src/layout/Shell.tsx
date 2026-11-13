/**
 * Layout of every signed-in view: the map fills the screen, the status line sits on top, the dock at the
 * bottom, and the current view (a sheet, a panel or nothing for the fleet) is rendered in the stage. The alert
 * pill and the KPI corners float over the map; the notifier announces and sounds the alerts that need an operator.
 *
 * The realtime connection is opened here, once the user is signed in, and closed when the shell unmounts
 * (sign-out or expiry). So is the live fleet: it is emptied when the shell unmounts, so that a later sign-in never
 * shows the robots of the previous session.
 */
import type * as React from "react";
import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { useApiHealth } from "../api/health";
import { AlertNotifier } from "../alerts/AlertNotifier";
import { AlertPill } from "../alerts/AlertPill";
import { DemoBanner } from "../demo/DemoBanner";
import { useServices } from "../app/services";
import { useAuthStore } from "../auth/auth-store";
import { KpiCorners } from "../kpi/KpiCorners";
import { alertSound, installAudioUnlock } from "../live/alert-sound";
import { robotsOnline } from "../live/fleet-selectors";
import { useFleetStore } from "../live/fleet-store";
import { useAlertFeed } from "../live/alerts-feed";
import { useNow } from "../live/use-now";
import { tokens } from "../theme/tokens";
import { useWsStore } from "../ws/ws-store";
import { Dock } from "./Dock";
import { MapStage } from "./MapStage";
import { useOpenAlertCount } from "./open-alerts";
import { SEARCH_PATH, isSearchShortcut } from "./shortcuts";
import { StatusLine } from "./StatusLine";
import styles from "./Shell.module.css";

/**
 * Renders the layout and the nested route.
 *
 * @returns The shell.
 */
export function Shell(): React.JSX.Element {
  const { ws } = useServices();
  const navigate = useNavigate();
  const role = useAuthStore((state) => state.role);
  const connection = useWsStore((state) => state.connection);
  const health = useApiHealth();
  const now = useNow(tokens.live.nowTickMs);
  // Selects the count, a primitive: the shell re-renders when the count changes, not on every robot delta.
  const online = useFleetStore((state) => robotsOnline(state, now, connection === "open"));
  const openAlerts = useOpenAlertCount();
  useAlertFeed();

  useEffect(() => {
    ws.connect();
    return () => {
      ws.close();
    };
  }, [ws]);

  // The first gesture of the page unlocks audio for the alert sound (ADR 0060).
  useEffect(() => installAudioUnlock(alertSound), []);

  useEffect(() => {
    return () => {
      useFleetStore.getState().reset(Date.now());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        void navigate(SEARCH_PATH);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navigate]);

  return (
    <div className={styles.shell}>
      <div className={styles.top}>
        <DemoBanner />
        <StatusLine
          ws={connection}
          api={health}
          robotsOnline={online}
          openAlerts={openAlerts}
          role={role}
        />
      </div>
      <main className={styles.stage}>
        <MapStage />
        <AlertPill />
        <KpiCorners />
        <Outlet />
      </main>
      <Dock role={role} />
      <AlertNotifier />
    </div>
  );
}
