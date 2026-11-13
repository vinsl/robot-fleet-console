/**
 * Polls the agent's status once per second, and reports when the agent can no longer be trusted.
 *
 * A single failed poll is ignored: the agent may be busy for a moment. Several failures in a row, or
 * any refusal of the session key, mean the page must stop, so the poller stops itself and calls back
 * once. The status drives the banner and the tags; it never drives a command.
 */
import type { VideoStatus } from "@mfc/protocol";
import type { AgentApi } from "./claim-client";

/** Interval between two polls, in milliseconds. */
const POLL_INTERVAL_MS = 1_000;

/** Consecutive failed polls after which the agent is considered unreachable (about five seconds). */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Why the poller gave up. */
export type LostReason = "agent-unreachable" | "unauthorised";

/** What the poller needs: the calls, the session key and two callbacks. */
export interface StatusPollerDeps {
  readonly api: AgentApi;
  readonly sessionKey: string;
  readonly onStatus: (status: VideoStatus) => void;
  readonly onLost: (reason: LostReason) => void;
  /** Overrides the interval, for the tests. */
  readonly intervalMs?: number;
  /** Overrides the failure bound, for the tests. */
  readonly maxFailures?: number;
}

/**
 * Starts polling the agent's status.
 *
 * @param deps - The calls, the session key and the callbacks.
 * @returns A function that stops the poller without calling back.
 */
export function startStatusPoller(deps: StatusPollerDeps): () => void {
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const maxFailures = deps.maxFailures ?? MAX_CONSECUTIVE_FAILURES;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const lose = (reason: LostReason): void => {
    stop();
    deps.onLost(reason);
  };

  const poll = async (): Promise<void> => {
    timer = null;
    const result = await deps.api.status(deps.sessionKey);
    if (stopped) {
      return;
    }
    if (result.ok) {
      failures = 0;
      deps.onStatus(result.value);
    } else if (result.error.kind === "problem" && result.error.status === 401) {
      lose("unauthorised");
      return;
    } else {
      failures += 1;
      if (failures >= maxFailures) {
        lose("agent-unreachable");
        return;
      }
    }
    timer = setTimeout(() => {
      void poll();
    }, intervalMs);
  };

  void poll();
  return stop;
}
