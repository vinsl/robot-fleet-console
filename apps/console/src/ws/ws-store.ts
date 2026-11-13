/**
 * UI state of the realtime connection: its state and the time of the last frame received.
 *
 * Fleet data is not kept here; the views that need it own their state (later milestones).
 */
import { create } from "zustand";
import type { WsState } from "./ws-client";

/** Observable realtime state. */
export interface WsStoreState {
  /** Connection state, as reported by the client. */
  readonly connection: WsState;
  /** Epoch milliseconds of the last valid frame, or `null` when none arrived yet. */
  readonly lastMessageAt: number | null;
  /**
   * @param connection - The new connection state.
   */
  setConnection(connection: WsState): void;
  /** Records that a valid frame arrived now. */
  markMessage(): void;
}

/** Realtime store of the console. */
export const useWsStore = create<WsStoreState>()((set) => ({
  connection: "idle",
  lastMessageAt: null,
  setConnection: (connection) => {
    set({ connection });
  },
  markMessage: () => {
    set({ lastMessageAt: Date.now() });
  },
}));
