/**
 * Zustand store of the live fleet. The reducer decides what changes; the store only publishes the result,
 * and only when the reducer returned a new object.
 */
import { create } from "zustand";
import type { WsServerMessage } from "@mfc/protocol";
import { applyFrame, emptyFleet, type FleetData } from "./fleet-reducer";

/** The live fleet and the actions that change it. */
export interface FleetStoreState extends FleetData {
  /**
   * Applies one validated server frame.
   *
   * @param frame - The frame.
   * @param now - Client time of the arrival, in milliseconds.
   */
  applyFrame(frame: WsServerMessage, now: number): void;
  /**
   * Empties the fleet, for example when the console switches site.
   *
   * @param now - Client time at which the new session starts.
   */
  reset(now: number): void;
}

/** Live fleet store of the console. */
export const useFleetStore = create<FleetStoreState>()((set, get) => ({
  ...emptyFleet(Date.now()),
  applyFrame: (frame, now) => {
    const current = get();
    const next = applyFrame(current, frame, now);
    if (next !== current) {
      set({
        robots: next.robots,
        snapshotAt: next.snapshotAt,
        session: next.session,
        droppedRobots: next.droppedRobots,
      });
    }
  },
  reset: (now) => {
    const empty = emptyFleet(now);
    set({
      robots: empty.robots,
      snapshotAt: empty.snapshotAt,
      session: empty.session,
      droppedRobots: empty.droppedRobots,
    });
  },
}));
