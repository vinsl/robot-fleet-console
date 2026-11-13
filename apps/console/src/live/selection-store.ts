/**
 * Robot selection requested from outside the map, for example from the robots list or the alert pill.
 *
 * A request carries a nonce, so that asking twice for the same robot still moves the focus again.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { RobotId } from "@mfc/protocol";

/** A request to focus one robot. */
export interface FocusRequest {
  readonly robotId: RobotId;
  /** Increases with every request, so that a repeated request is still a change. */
  readonly nonce: number;
}

/** The selection state and its setter. */
export interface SelectionState {
  /** The latest request, or `null` when none was made. */
  readonly focus: FocusRequest | null;
  /**
   * @param robotId - The robot to focus.
   */
  requestFocus(robotId: RobotId): void;
}

/** Selection store of the console. */
export const useSelectionStore: UseBoundStore<StoreApi<SelectionState>> = create<SelectionState>()(
  (set, get) => ({
    focus: null,
    requestFocus: (robotId) => {
      const nonce = (get().focus?.nonce ?? 0) + 1;
      set({ focus: { robotId, nonce } });
    },
  }),
);
