/**
 * Maps the realtime client state to the connection visual shown in the status line.
 *
 * The visuals (colour, icon, label) live in `robot-state-visuals.ts`; this module only decides which one
 * applies. A first attempt counts as reconnecting, because the status line has no separate "connecting"
 * visual and the difference lasts a fraction of a second.
 */
import type { CONNECTION_VISUALS } from "../theme/robot-state-visuals";
import type { WsState } from "../ws/ws-client";

/** Key of a connection visual. */
export type ConnectionStatus = keyof typeof CONNECTION_VISUALS;

/**
 * Chooses the connection visual for a realtime state.
 *
 * @param ws - The realtime client state.
 * @returns `live` when frames flow, `reconnecting` while an attempt is pending, `offline` otherwise.
 */
export function connectionStatusOf(ws: WsState): ConnectionStatus {
  switch (ws) {
    case "open":
      return "live";
    case "connecting":
    case "reconnecting":
      return "reconnecting";
    case "idle":
    case "closed":
      return "offline";
  }
}
