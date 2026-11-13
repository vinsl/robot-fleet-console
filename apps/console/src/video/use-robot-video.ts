/**
 * State of the video pane of one robot: starts one viewer while the pane is mounted and stops it on unmount or when
 * the robot changes. One viewer per open panel, so a closed panel costs no bandwidth and no credentials (ADR 0067).
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { thingName, type RobotId } from "@mfc/protocol";
import { useServices } from "../app/services";
import { createCredentialProvider } from "./kvs-credentials";
import { connectViewer, type ViewerState } from "./kvs-viewer";

/** What the pane renders, and the element it must attach to. */
export interface RobotVideo {
  /** The pane state: connecting, live, or unavailable. */
  readonly state: ViewerState;
  /** Round trip of the media path in milliseconds, or `null` until the first sample of a live connection. */
  readonly rttMs: number | null;
  /** Attach to the `<video>` element the viewer plays into. */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
}

/**
 * Connects the viewer of a robot while the calling component is mounted.
 *
 * The channel name is built here from the validated robot id, so no free text can name another channel. The
 * credential provider lives as long as the pane, so the identity pool is called once per panel and refreshed near
 * expiry.
 *
 * @param robotId - The robot whose camera the pane shows. The route has validated it.
 * @returns The pane state and the element reference.
 */
export function useRobotVideo(robotId: RobotId): RobotVideo {
  const { config, auth } = useServices();
  const credentials = useMemo(() => createCredentialProvider(config, auth), [config, auth]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ViewerState>("connecting");
  const [rttMs, setRttMs] = useState<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return undefined;
    }
    return connectViewer({
      region: config.region,
      channelName: thingName(robotId),
      credentials,
      video,
      onState: (next) => {
        setState(next);
        // A figure from the previous connection would be wrong for the new one.
        if (next === "connecting") {
          setRttMs(null);
        }
      },
      onStats: (stats) => {
        setRttMs(stats.rttMs);
      },
    });
  }, [config.region, credentials, robotId]);

  return { state, rttMs, videoRef };
}
