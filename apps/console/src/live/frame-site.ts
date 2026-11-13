/**
 * Site scoping of the server frames. The console shows one site; a frame that names another site must never
 * reach the fleet store, the frame bus or the alerts feed, even if the server sent it by mistake.
 */
import type { SiteId, WsServerMessage } from "@mfc/protocol";

/**
 * Tells whether a validated server frame belongs to a site.
 *
 * An alert frame belongs to the site only when both its envelope and the alert it carries name that site.
 * The `error` frame names no site: it concerns the connection, not the fleet, so it is always kept.
 *
 * @param frame - A validated server frame.
 * @param siteId - The site the console shows.
 * @returns `true` when the frame may be shown for that site.
 */
export function isFrameForSite(frame: WsServerMessage, siteId: SiteId): boolean {
  switch (frame.type) {
    case "error":
      return true;
    case "alert.changed":
      return frame.siteId === siteId && frame.alert.siteId === siteId;
    case "fleet.delta":
    case "fleet.snapshot":
    case "robot.presence":
    case "robot.event":
    case "command.ack":
    case "lock.changed":
      return frame.siteId === siteId;
  }
}
