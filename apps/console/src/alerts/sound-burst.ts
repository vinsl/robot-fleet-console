/**
 * Merges bursts of alert sounds: a pattern plays at most once per window, however many alerts ask for it.
 *
 * Several alerts can open in the same second (a fleet fault spreads to its neighbours). Without a merge, each
 * one would stack a tone pattern on the last and the sound would turn into noise. One pattern lasts about
 * `toneMs + gapMs`, so a second request inside that window adds nothing the operator can hear (security finding
 * L3: the sound is also a denial-of-attention vector when the feed floods).
 *
 * @module alerts/sound-burst
 */
import type { SoundPattern } from "../live/alert-sound";

/** Decides whether a sound pattern may play now. */
export interface BurstGate {
  /**
   * Records a request for a pattern and tells whether it may play.
   *
   * @param pattern - The pattern requested.
   * @returns `true` when the pattern may play now; `false` when it merges into one that just played.
   */
  allow(pattern: SoundPattern): boolean;
}

/**
 * Creates a gate that lets one pattern through per window. Each pattern has its own window, so a Critical
 * pattern is not held back by a Major one.
 *
 * A clock that goes backwards (a clock adjustment) does not block sounds: the window restarts from the new time.
 *
 * @param windowMs - Minimum time between two plays of the same pattern, in milliseconds.
 * @param clock - Current time in epoch milliseconds. Injected so that tests control time.
 * @returns The gate.
 */
export function createBurstGate(windowMs: number, clock: () => number = Date.now): BurstGate {
  const lastPlayedAt = new Map<SoundPattern, number>();
  return {
    allow(pattern) {
      const now = clock();
      const last = lastPlayedAt.get(pattern);
      if (last !== undefined && now >= last && now - last < windowMs) {
        return false;
      }
      lastPlayedAt.set(pattern, now);
      return true;
    },
  };
}
