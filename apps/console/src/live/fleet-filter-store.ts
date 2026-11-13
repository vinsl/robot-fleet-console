/**
 * Filter of the robots list and of the fleet map: text, states, open alerts and low battery. The filter is
 * client state only; it is not kept across a reload.
 */
import { create } from "zustand";
import type { RobotState } from "@mfc/protocol";
import type { RobotView } from "./fleet-selectors";

/** Criteria of the robots list. An empty criterion matches every robot. */
export interface FleetFilter {
  /** Text the robot identifier must contain, case-insensitive. Blank matches everything. */
  readonly text: string;
  /** States to keep. Empty keeps every state. */
  readonly states: readonly RobotState[];
  /** Keep only the robots with an OPEN or ACKNOWLEDGED alert. */
  readonly withAlert: boolean;
  /** Keep only the robots with a low battery. */
  readonly lowBattery: boolean;
}

/** The filter that matches every robot. */
export const EMPTY_FILTER: FleetFilter = {
  text: "",
  states: [],
  withAlert: false,
  lowBattery: false,
};

/**
 * Tells whether any criterion narrows the list.
 *
 * @param filter - The filter to check.
 * @returns `true` when at least one criterion is set.
 */
export function isFilterActive(filter: FleetFilter): boolean {
  return (
    filter.text.trim() !== "" || filter.states.length > 0 || filter.withAlert || filter.lowBattery
  );
}

/**
 * Tells whether a robot passes the filter. All set criteria must hold.
 *
 * @param view - The derived view of the robot.
 * @param filter - The criteria.
 * @param openAlertRobotIds - Robots with an OPEN or ACKNOWLEDGED alert.
 * @returns `true` when the robot is shown.
 */
export function matchesFilter(
  view: RobotView,
  filter: FleetFilter,
  openAlertRobotIds: ReadonlySet<string>,
): boolean {
  const text = filter.text.trim().toLowerCase();
  if (text !== "" && !view.robot.robotId.toLowerCase().includes(text)) {
    return false;
  }
  if (filter.states.length > 0 && !filter.states.includes(view.displayState)) {
    return false;
  }
  if (filter.withAlert && !openAlertRobotIds.has(view.robot.robotId)) {
    return false;
  }
  if (filter.lowBattery && !view.badges.includes("lowBattery")) {
    return false;
  }
  return true;
}

/** The filter state and its setters. */
interface FleetFilterState {
  readonly filter: FleetFilter;
  /**
   * @param next - The filter to apply.
   */
  setFilter(next: FleetFilter): void;
  /** Resets the filter to {@link EMPTY_FILTER}. */
  clear(): void;
}

/** Filter store of the robots list and the map. */
export const useFleetFilterStore = create<FleetFilterState>()((set) => ({
  filter: EMPTY_FILTER,
  setFilter: (next) => {
    set({ filter: next });
  },
  clear: () => {
    set({ filter: EMPTY_FILTER });
  },
}));
