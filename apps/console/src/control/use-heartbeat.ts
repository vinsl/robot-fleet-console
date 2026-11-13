/**
 * Heartbeat of the lock holder: while the panel holds the lock, the console tells the cloud every 250 ms that
 * it is still there (ADR 0063). The cloud turns each heartbeat into a robot heartbeat, and a robot whose
 * heartbeats stop pauses (deadman).
 *
 * The frame carries no token: the cloud finds the holder from the verified connection. A failed send does not
 * stop the timer, because the socket reconnects on its own; the hook reports the failure through `linkOk`, so
 * the lock line can warn the operator that the robot will pause.
 */
import { useEffect, useState } from "react";
import { CONSOLE_HEARTBEAT_INTERVAL_MS, type RobotId } from "@mfc/protocol";
import { useServices } from "../app/services";

/** What the heartbeat reports to the panel. */
export interface HeartbeatState {
  /** `false` when the last heartbeat could not be sent, because the socket is not open. */
  readonly linkOk: boolean;
}

/**
 * Sends heartbeats for one robot while `active` is true.
 *
 * @param robotId - The robot whose lock the console holds.
 * @param active - Whether the console holds the lock; the timer runs only then.
 * @returns The link state.
 */
export function useHeartbeat(robotId: RobotId, active: boolean): HeartbeatState {
  const { ws } = useServices();
  const [linkOk, setLinkOk] = useState(true);

  useEffect(() => {
    if (!active) {
      // A stale "link lost" must not outlive the lock: once no heartbeat is due, the line shows no warning.
      setLinkOk(true);
      return;
    }
    // A hidden tab is intentionally not handled here. Browsers throttle its timers (ADR 0063), so the heartbeat
    // slows and the robot pauses: a fail-safe, preferred to a worker timer that would drive a robot nobody watches.
    const timer = setInterval(() => {
      setLinkOk(ws.send({ type: "heartbeat", robotId }));
    }, CONSOLE_HEARTBEAT_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, robotId, ws]);

  return { linkOk };
}
