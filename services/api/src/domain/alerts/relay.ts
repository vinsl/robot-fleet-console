/**
 * Relay of the `alert.changed` frames of an acknowledgement or a resolution.
 *
 * The frame goes to every role in reliable mode, as the opening frame does. The relay is best effort after the
 * change is committed: a failed push never fails the operator action, and the consoles refetch the active alerts
 * on a timer, so a lost frame heals (ADR 0061).
 */
import type { WsServerMessage } from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import { fanOut, type FanOutDeps } from "../realtime/fanout";
import type { AlertRelayPort, AlertsMetrics } from "./ports";

/** Dependencies of the relay: the fan-out ports, plus the metrics sink of the alerts use cases. */
export type AlertRelayDeps = FanOutDeps & { readonly metrics: AlertsMetrics };

/**
 * Builds the relay of the alert changes.
 *
 * @param deps - The connections, push port, clock and logger of the fan-out.
 * @returns A relay that never throws.
 */
export function createAlertRelay(deps: AlertRelayDeps): AlertRelayPort {
  return {
    async alertChanged(siteId, change, alert): Promise<void> {
      const frame: WsServerMessage = { type: "alert.changed", siteId, change, alert };
      try {
        await fanOut(siteId, [frame], "reliable", deps);
      } catch (error) {
        deps.logger.warn("alert change relay failed", safeErrorFields(error));
      }
    },
  };
}
