/**
 * State history of one robot as the panel shows it: the states it went through in the last ten minutes.
 *
 * The history is session-scoped, like the KPIs (ADR 0059): it is built from the live frames the console received
 * since the panel opened and is not read from the server. Only changes are recorded, so the list reads as a
 * sequence of states and not as a copy of every frame.
 */
import type { RobotState } from "@mfc/protocol";

/** How far back the history reaches. Ten minutes is what the panel title promises. */
export const TIMELINE_WINDOW_MS = 600_000;

/** Most entries kept, so a robot that flaps between two states cannot grow the list without bound. */
export const TIMELINE_CAPACITY = 50;

/** One change of state, with the client time it was seen at. */
export interface TimelineEntry {
  readonly state: RobotState;
  /** `Date.now()` when the change was seen, in epoch milliseconds. */
  readonly atMs: number;
}

/**
 * Records a state in the history. An unchanged state is ignored; entries older than the window are dropped and
 * the list is capped at the most recent entries.
 *
 * @param timeline - The history so far, oldest first.
 * @param state - The state the robot is in now.
 * @param atMs - Client time at which the state was seen, in epoch milliseconds.
 * @param windowMs - How far back entries are kept.
 * @param cap - Most entries kept.
 * @returns The new history. The same array when the state did not change.
 */
export function appendState(
  timeline: readonly TimelineEntry[],
  state: RobotState,
  atMs: number,
  windowMs: number = TIMELINE_WINDOW_MS,
  cap: number = TIMELINE_CAPACITY,
): readonly TimelineEntry[] {
  const last = timeline[timeline.length - 1];
  if (last?.state === state) {
    return timeline;
  }
  const kept = timeline.filter((entry) => atMs - entry.atMs <= windowMs);
  const next = [...kept, { state, atMs }];
  return next.slice(Math.max(0, next.length - cap));
}
