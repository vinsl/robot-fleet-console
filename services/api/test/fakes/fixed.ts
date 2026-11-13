/**
 * Deterministic clock, identifiers and deadline for the robot use cases.
 */
import { uuidv7, type Uuidv7 } from "@mfc/protocol";
import type { Clock, Deadline, Ids } from "../../src/domain/ports";

/** A clock that moves only when a test says so. */
export class FixedClock implements Clock {
  private current: number;

  /** @param start - The instant the clock starts at. */
  constructor(start: Date) {
    this.current = start.getTime();
  }

  /** @returns A copy of the current instant. */
  now(): Date {
    return new Date(this.current);
  }

  /**
   * Moves the clock forward.
   *
   * @param ms - Milliseconds to add.
   */
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Identifier source that yields distinct, time-ordered UUIDv7 values in sequence. */
export class SequentialIds implements Ids {
  private counter = 0;

  /** @returns The next identifier of the sequence. */
  uuidv7(): Uuidv7 {
    this.counter += 1;
    const n = this.counter;
    return uuidv7(1_700_000_000_000 + n, (count) => new Uint8Array(count).fill(n % 256));
  }
}

/**
 * Deadline whose remaining time is scripted: the queued values are returned first, then the default.
 */
export class ScriptedDeadline implements Deadline {
  private readonly queued: number[] = [];

  /** @param defaultMs - The remaining time once the queue is empty. */
  constructor(private readonly defaultMs: number) {}

  /**
   * Queues the next values of `remainingMs`, in order.
   *
   * @param values - Milliseconds, one per call.
   */
  queue(...values: number[]): void {
    this.queued.push(...values);
  }

  /** @returns The next queued value, or the default. */
  remainingMs(): number {
    return this.queued.shift() ?? this.defaultMs;
  }
}
