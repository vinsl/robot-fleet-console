/**
 * Robots list filter: text, state, open alert and low battery criteria, alone and combined.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  isFilterActive,
  matchesFilter,
  type FleetFilter,
} from "../../src/live/fleet-filter-store";
import { robotView } from "../../src/live/fleet-selectors";
import { robotOf } from "./support";

const NOW = 1_000;
const NO_ALERTS: ReadonlySet<string> = new Set();

/**
 * Builds a filter from the defaults and overrides.
 *
 * @param overrides - Criteria to set.
 * @returns The filter.
 */
function filterOf(overrides: Partial<FleetFilter>): FleetFilter {
  return { ...EMPTY_FILTER, ...overrides };
}

describe("matchesFilter", () => {
  it("matches every robot with the empty filter", () => {
    expect(
      matchesFilter(robotView(robotOf({ lastHeardAt: NOW }), NOW, true), EMPTY_FILTER, NO_ALERTS),
    ).toBe(true);
  });

  it("matches the identifier by case-insensitive text, ignoring surrounding blanks", () => {
    const view = robotView(robotOf({ robotId: "sim-07", lastHeardAt: NOW }), NOW, true);
    expect(matchesFilter(view, filterOf({ text: "  SIM-0 " }), NO_ALERTS)).toBe(true);
    expect(matchesFilter(view, filterOf({ text: "sim-08" }), NO_ALERTS)).toBe(false);
  });

  it("keeps only the listed states", () => {
    const view = robotView(robotOf({ state: "BLOCKED", lastHeardAt: NOW }), NOW, true);
    expect(matchesFilter(view, filterOf({ states: ["BLOCKED", "ESTOP"] }), NO_ALERTS)).toBe(true);
    expect(matchesFilter(view, filterOf({ states: ["IDLE"] }), NO_ALERTS)).toBe(false);
  });

  it("keeps only the robots with an open or acknowledged alert when asked", () => {
    const view = robotView(robotOf({ robotId: "sim-02", lastHeardAt: NOW }), NOW, true);
    expect(matchesFilter(view, filterOf({ withAlert: true }), new Set(["sim-02"]))).toBe(true);
    expect(matchesFilter(view, filterOf({ withAlert: true }), NO_ALERTS)).toBe(false);
  });

  it("keeps only the low battery robots when asked", () => {
    const low = robotView(robotOf({ battery: 10, lastHeardAt: NOW }), NOW, true);
    const full = robotView(robotOf({ battery: 90, lastHeardAt: NOW }), NOW, true);
    expect(matchesFilter(low, filterOf({ lowBattery: true }), NO_ALERTS)).toBe(true);
    expect(matchesFilter(full, filterOf({ lowBattery: true }), NO_ALERTS)).toBe(false);
  });

  it("requires every set criterion to hold", () => {
    const view = robotView(
      robotOf({ robotId: "sim-03", state: "BLOCKED", battery: 10, lastHeardAt: NOW }),
      NOW,
      true,
    );
    const combined = filterOf({
      text: "sim",
      states: ["BLOCKED"],
      withAlert: true,
      lowBattery: true,
    });
    expect(matchesFilter(view, combined, new Set(["sim-03"]))).toBe(true);
    expect(matchesFilter(view, combined, NO_ALERTS)).toBe(false);
  });
});

describe("isFilterActive", () => {
  it("is false for the empty filter and for a blank text", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(filterOf({ text: "   " }))).toBe(false);
  });

  it("is true when any criterion is set", () => {
    expect(isFilterActive(filterOf({ text: "a" }))).toBe(true);
    expect(isFilterActive(filterOf({ states: ["IDLE"] }))).toBe(true);
    expect(isFilterActive(filterOf({ withAlert: true }))).toBe(true);
    expect(isFilterActive(filterOf({ lowBattery: true }))).toBe(true);
  });
});
