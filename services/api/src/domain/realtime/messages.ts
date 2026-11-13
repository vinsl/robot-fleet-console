/**
 * Builders and serialiser of the WebSocket server frames.
 *
 * A frame is validated by the protocol schema before it is serialised, so a frame that leaves the cloud
 * is one the console accepts. A fleet delta is split so that every frame fits under the frame size bound.
 */
import {
  FLEET_DELTA_MAX_ROBOTS,
  WS_MAX_SERVER_FRAME_BYTES,
  WsServerMessageSchema,
  type FleetRobotSample,
  type IsoMs,
  type SiteId,
  type WsServerMessage,
} from "@mfc/protocol";

/**
 * Bytes of a serialised frame, measured on its JSON text.
 *
 * @param message - The frame.
 * @returns The UTF-8 length of its JSON text.
 */
function frameBytes(message: WsServerMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Builds one `fleet.delta` frame.
 *
 * @param siteId - The site of the robots.
 * @param robots - The samples of the frame.
 * @param sentAt - The time the cloud sends the frame.
 * @returns The frame, not yet validated.
 */
function deltaOf(
  siteId: SiteId,
  robots: readonly FleetRobotSample[],
  sentAt: IsoMs,
): WsServerMessage {
  return { type: "fleet.delta", siteId, sentAt, robots: [...robots] };
}

/**
 * Splits the samples of one site into `fleet.delta` frames. Each frame holds at most
 * {@link FLEET_DELTA_MAX_ROBOTS} robots and serialises to at most {@link WS_MAX_SERVER_FRAME_BYTES}.
 *
 * @param siteId - The site of the samples.
 * @param samples - The samples, one per robot.
 * @param sentAt - The time the cloud sends the frames.
 * @returns The frames, in the order of the samples. Empty when there are no samples.
 * @throws {Error} When one sample alone exceeds the frame size bound: a sample is bounded by its schema,
 * so this is a programming error, not a data error.
 */
export function buildFleetDelta(
  siteId: SiteId,
  samples: readonly FleetRobotSample[],
  sentAt: IsoMs,
): WsServerMessage[] {
  const frames: WsServerMessage[] = [];
  let chunk: FleetRobotSample[] = [];
  for (const sample of samples) {
    const candidate = [...chunk, sample];
    const fits =
      candidate.length <= FLEET_DELTA_MAX_ROBOTS &&
      frameBytes(deltaOf(siteId, candidate, sentAt)) <= WS_MAX_SERVER_FRAME_BYTES;
    if (fits) {
      chunk = candidate;
      continue;
    }
    if (chunk.length > 0) {
      frames.push(deltaOf(siteId, chunk, sentAt));
    }
    if (frameBytes(deltaOf(siteId, [sample], sentAt)) > WS_MAX_SERVER_FRAME_BYTES) {
      throw new Error("a fleet sample exceeds the frame size bound");
    }
    chunk = [sample];
  }
  if (chunk.length > 0) {
    frames.push(deltaOf(siteId, chunk, sentAt));
  }
  return frames;
}

/**
 * Validates a server frame and serialises it to the JSON text sent on the socket. The schema bounds every
 * list of a frame, and {@link buildFleetDelta} bounds the size of each delta, so a valid frame is within the
 * frame size limit by construction.
 *
 * @param message - The frame to send.
 * @returns The JSON text.
 * @throws {ZodError} When the frame breaks the protocol schema. That is a programming error: the frames are
 * built by the cloud from validated data.
 */
export function serialize(message: WsServerMessage): string {
  return JSON.stringify(WsServerMessageSchema.parse(message));
}
