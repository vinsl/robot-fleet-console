/**
 * Idle release of the robot lock (FR-AUTH-4): a console that holds a lock and receives no input for 30 minutes
 * gives the lock up, so that an operator who walked away does not keep a robot under control.
 *
 * Input is listened to on the whole document, so a click anywhere in the console counts. The listeners are
 * passive: they only reset a timer and never change what the user does.
 */
import { useEffect, useRef } from "react";
import { CONSOLE_IDLE_RELEASE_MS } from "@mfc/protocol";

/** Input events that count as activity. Pointer and touch cover the mouse, the pen and the touch screen. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Calls `onIdle` once when no input arrived for `timeoutMs` while `active` is true.
 *
 * @param active - Whether the console holds the lock; the timer runs only then.
 * @param onIdle - Called once when the idle timeout passes. It may return a promise (the release request). When that
 *   promise settles and `active` is still true, the lock is still held, so the timer is armed again: a failed
 *   release must not leave the robot under an unattended lock. Read through a ref, so a new callback does not
 *   restart the timer.
 * @param timeoutMs - Idle duration after which `onIdle` is called. Defaults to the protocol's idle release time.
 */
export function useIdleRelease(
  active: boolean,
  onIdle: () => Promise<void> | undefined,
  timeoutMs: number = CONSOLE_IDLE_RELEASE_MS,
): void {
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let fired = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fire = (): void => {
      fired = true;
      const pending = onIdleRef.current();
      if (pending === undefined) {
        return;
      }
      // Re-arm whether the request succeeded or failed: a success flips `active` and the effect is torn down, so
      // only a lock that is still held gets a new idle period.
      const rearm = (): void => {
        if (!disposed) {
          fired = false;
          arm();
        }
      };
      void pending.then(rearm, rearm);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(fire, timeoutMs);
    };
    // Once the lock is given up the console stops watching input; a new lock starts a new idle period.
    const onActivity = (): void => {
      if (!fired) {
        arm();
      }
    };

    arm();
    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, onActivity, { passive: true });
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) {
        document.removeEventListener(type, onActivity);
      }
    };
  }, [active, timeoutMs]);
}
