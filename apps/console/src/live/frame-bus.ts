/**
 * Fan-out of the valid server frames to the consumers that need them besides the fleet store (today the
 * alerts feed). A consumer subscribes once and gets every frame in arrival order.
 */
import type { WsServerMessage } from "@mfc/protocol";

/** Receives one server frame. */
export type FrameListener = (frame: WsServerMessage) => void;

/** Subscribers, in subscription order. */
const listeners = new Set<FrameListener>();

/**
 * Delivers a frame to every current subscriber.
 *
 * @param frame - A validated server frame.
 */
export function publishFrame(frame: WsServerMessage): void {
  for (const listener of listeners) {
    listener(frame);
  }
}

/**
 * Subscribes to every frame.
 *
 * @param listener - Called with each frame.
 * @returns A function that removes the subscription.
 */
export function subscribeFrames(listener: FrameListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
