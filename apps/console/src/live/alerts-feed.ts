/**
 * Live feed of the alerts: patches the alert cache from `alert.changed` frames, announces newly opened
 * alerts to the notifier, and refetches the lists after every reconnection (ADR 0057, D10).
 */
import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { DEMO_SITE_ID, type AlertRecord, type WsServerMessage } from "@mfc/protocol";
import { ALERTS_KEY, activeAlertsKey, upsertAlert } from "../api/alerts";
import { subscribeFrames } from "./frame-bus";
import { useWsStore } from "../ws/ws-store";

/** Receives an alert that was opened by a live frame. */
export type AlertOpenedListener = (alert: AlertRecord) => void;

/** The `alert.changed` variant of the server frames. */
type AlertChangedFrame = Extract<WsServerMessage, { type: "alert.changed" }>;

/** Listeners of newly opened alerts. */
const openedListeners = new Set<AlertOpenedListener>();

/**
 * Subscribes to alerts opened by a live frame. An alert that was already known (for example loaded from
 * the list at page load) never reaches a subscriber, so a reload does not replay a sound.
 *
 * @param listener - Called once per newly opened alert.
 * @returns A function that removes the subscription.
 */
export function subscribeAlertOpened(listener: AlertOpenedListener): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

/**
 * Tells whether an alert is already in the active list of the cache.
 *
 * @param queryClient - The query cache.
 * @param alertId - The alert identifier.
 * @returns `true` when the cache holds the alert as active.
 */
function isKnownActive(queryClient: QueryClient, alertId: string): boolean {
  const current = queryClient.getQueryData<readonly AlertRecord[]>(activeAlertsKey(DEMO_SITE_ID));
  return current?.some((alert) => alert.alertId === alertId) ?? false;
}

/**
 * Applies an `alert.changed` frame to the cache. An OPENED frame for an alert the cache did not hold emits
 * to the opened listeners, once.
 *
 * @param queryClient - The query cache.
 * @param frame - The frame.
 */
export function applyAlertFrame(queryClient: QueryClient, frame: AlertChangedFrame): void {
  const isNew = frame.change === "OPENED" && !isKnownActive(queryClient, frame.alert.alertId);
  upsertAlert(queryClient, frame.alert);
  if (isNew) {
    for (const listener of openedListeners) {
      listener(frame.alert);
    }
  }
}

/**
 * Mounted once by the shell. Subscribes to the frame bus for the alert frames, and invalidates the alert
 * queries when the connection opens again after a drop, so that alerts missed during the gap come back.
 */
export function useAlertFeed(): void {
  const queryClient = useQueryClient();
  const connection = useWsStore((state) => state.connection);
  // Per mount on purpose: after a Shell remount the queries are fresh, so the first open skips the invalidate.
  const hasOpened = useRef(false);

  useEffect(() => {
    return subscribeFrames((frame) => {
      if (frame.type === "alert.changed") {
        applyAlertFrame(queryClient, frame);
      }
    });
  }, [queryClient]);

  useEffect(() => {
    if (connection !== "open") {
      return;
    }
    if (hasOpened.current) {
      void queryClient.invalidateQueries({ queryKey: [ALERTS_KEY] });
    }
    hasOpened.current = true;
  }, [connection, queryClient]);
}
