/**
 * Relay of the `lock.changed` frames.
 *
 * The frame goes to every role in reliable mode: the holder label is visible to the Viewer too (the lock line is text
 * only for them). The relay is best effort after the lock is committed: a failed push never fails the operator action,
 * and the consoles refetch the lock state when they open a robot, so a lost frame heals.
 */
import type { WsServerMessage } from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import { fanOut, type FanOutDeps } from "../realtime/fanout";
import type { ControlRelayPort } from "./ports";

/**
 * Builds the relay of the lock changes.
 *
 * @param deps - The connections, push port, clock and logger of the fan-out.
 * @returns A relay that never throws.
 */
export function createControlRelay(deps: FanOutDeps): ControlRelayPort {
  return {
    async lockChanged(siteId, robotId, held, holder, cause): Promise<void> {
      // The optional holder is omitted rather than sent as undefined, so the frame carries no key it does not need.
      const frame: WsServerMessage = {
        type: "lock.changed",
        siteId,
        robotId,
        held,
        ...(holder === undefined ? {} : { holder }),
        cause,
      };
      try {
        await fanOut(siteId, [frame], "reliable", deps);
      } catch (error) {
        deps.logger.warn("lock change relay failed", safeErrorFields(error));
      }
    },
  };
}
