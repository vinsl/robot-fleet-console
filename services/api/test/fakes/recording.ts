/**
 * Logger and metrics that keep what they receive, so that tests can assert on it.
 */
import type { DomainLogger, DomainMetrics, RobotsMetricName } from "../../src/domain/ports";
import type { HandlerLogger } from "../../src/observability";

/** Level of a recorded log entry. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** One recorded log entry. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly attributes: object;
}

/** Logger that keeps every entry in memory. */
export class RecordingLogger implements DomainLogger {
  /** Every entry received, in order. */
  readonly entries: LogEntry[] = [];

  /** @param message - The message. @param attributes - The attributes. */
  debug(message: string, attributes: object = {}): void {
    this.entries.push({ level: "debug", message, attributes });
  }

  /** @param message - The message. @param attributes - The attributes. */
  info(message: string, attributes: object = {}): void {
    this.entries.push({ level: "info", message, attributes });
  }

  /** @param message - The message. @param attributes - The attributes. */
  warn(message: string, attributes: object = {}): void {
    this.entries.push({ level: "warn", message, attributes });
  }

  /** @param message - The message. @param attributes - The attributes. */
  error(message: string, attributes: object = {}): void {
    this.entries.push({ level: "error", message, attributes });
  }

  /**
   * Every entry as one JSON text, the form a log hygiene assertion searches.
   *
   * @returns The serialised entries.
   */
  text(): string {
    return JSON.stringify(this.entries);
  }
}

/** Metrics sink that counts in memory. */
export class RecordingMetrics implements DomainMetrics {
  private readonly counts = new Map<RobotsMetricName, number>();

  /** @param name - The metric to count. */
  count(name: RobotsMetricName): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * @param name - The metric.
   * @returns How many times it was counted.
   */
  countOf(name: RobotsMetricName): number {
    return this.counts.get(name) ?? 0;
  }
}

/**
 * Logger of a handler: keeps its entries, and the keys appended to it, so that a test can assert on the
 * correlation identifier of an invocation.
 */
export class RecordingHandlerLogger extends RecordingLogger implements HandlerLogger {
  /** Keys currently appended. */
  readonly keys = new Map<string, unknown>();

  /** The Lambda context is not under test here. */
  addContext(): void {
    // Intentionally empty: the context is not logged by these tests.
  }

  /** @param keys - Keys to append. */
  appendKeys(keys: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(keys)) {
      this.keys.set(key, value);
    }
  }

  /** @param keys - Keys to remove. */
  removeKeys(keys: string[]): void {
    for (const key of keys) {
      this.keys.delete(key);
    }
  }
}
