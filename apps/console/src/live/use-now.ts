/**
 * A clock that re-renders its component at a fixed cadence, so that ages and silence rules are shown
 * without a store update per tick.
 */
import { useEffect, useState } from "react";

/**
 * Returns the current time and refreshes it every `intervalMs`.
 *
 * @param intervalMs - Time between two refreshes, in milliseconds.
 * @returns The time in epoch milliseconds, as of the last refresh.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
