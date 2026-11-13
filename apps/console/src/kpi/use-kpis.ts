/**
 * React hook that computes the KPIs from the live fleet store, the realtime connection and the alert queries.
 * The values are recomputed every second, so the time windows move with the clock even without a new frame.
 *
 * @module kpi/use-kpis
 */
import { useMemo } from "react";
import type { AlertRecord } from "@mfc/protocol";
import { useActiveAlerts, useResolvedAlerts } from "../api/alerts";
import { useFleetStore } from "../live/fleet-store";
import type { FleetData } from "../live/fleet-reducer";
import { useNow } from "../live/use-now";
import { useWsStore } from "../ws/ws-store";
import { tokens } from "../theme/tokens";
import { computeKpis, type KpiValues } from "./kpi";

/** Stable empty list, so that the memoised inputs do not change while an alert query has no data. */
const NO_ALERTS: readonly AlertRecord[] = [];

/** The KPIs and what they rest on. */
export interface KpiSnapshot {
  /** The computed values. */
  readonly values: KpiValues;
  /** `true` when the alert history has more pages than the console read: interventions and MTTR are partial. */
  readonly partial: boolean;
  /** Client time, in milliseconds, at which the console opened the session the session KPIs cover. */
  readonly sessionStartedAt: number;
}

/**
 * Reads the live inputs of the KPIs and computes them.
 *
 * @returns The values, whether the alert history is partial, and the session start.
 */
export function useKpis(): KpiSnapshot {
  const robots = useFleetStore((state) => state.robots);
  const session = useFleetStore((state) => state.session);
  const snapshotAt = useFleetStore((state) => state.snapshotAt);
  const droppedRobots = useFleetStore((state) => state.droppedRobots);
  const connectionOpen = useWsStore((state) => state.connection === "open");
  const now = useNow(tokens.live.nowTickMs);
  const active = useActiveAlerts();
  const resolved = useResolvedAlerts();

  const fleet = useMemo<FleetData>(
    () => ({ robots, session, snapshotAt, droppedRobots }),
    [robots, session, snapshotAt, droppedRobots],
  );
  const activeAlerts = active.data ?? NO_ALERTS;
  const resolvedPages = resolved.data?.pages;
  const resolvedAlerts = useMemo(
    () => resolvedPages?.flatMap((page) => page.alerts) ?? NO_ALERTS,
    [resolvedPages],
  );
  const values = useMemo(
    () =>
      computeKpis({
        fleet,
        now,
        connectionOpen,
        active: activeAlerts,
        resolved: resolvedAlerts,
      }),
    [fleet, now, connectionOpen, activeAlerts, resolvedAlerts],
  );

  return {
    values,
    partial: resolved.hasNextPage,
    sessionStartedAt: session.startedAt,
  };
}
