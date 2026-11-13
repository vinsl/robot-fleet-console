/**
 * Clock of the command log: once a second it expires the commands that waited too long for their answer.
 *
 * The clock runs only while a robot panel is mounted, because nothing else shows the log. An unanswered command
 * that is not on screen is still expired the next time a panel opens.
 */
import { useEffect } from "react";
import { useCommandStore } from "./command-store";

/** How often the log is checked for commands without an answer. */
const CLOCK_TICK_MS = 1_000;

/**
 * Expires the pending commands once a second while the calling component is mounted.
 */
export function useCommandExpiry(): void {
  useEffect(() => {
    const timer = setInterval(() => {
      useCommandStore.getState().expire(performance.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
}
