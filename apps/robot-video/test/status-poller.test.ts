import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApi, Result } from "../src/lib/claim-client";
import { startStatusPoller } from "../src/lib/status-poller";
import type { VideoStatus } from "@mfc/protocol";
import { IDLE_STATUS, SESSION_KEY } from "./fixtures";

/** A status result that succeeded. */
const OK: Result<VideoStatus> = { ok: true, value: IDLE_STATUS };

/** A status result that failed with a network error. */
const NETWORK: Result<VideoStatus> = { ok: false, error: { kind: "network" } };

/** A status result refused with 401: the session key is not valid any more. */
const UNAUTHORISED: Result<VideoStatus> = {
  ok: false,
  error: { kind: "problem", status: 401, type: "urn:mfc:problem:unauthorised" },
};

/**
 * Builds an agent API whose status route answers from a script, one entry per call.
 *
 * @param script - The results, in the order of the calls. The last one repeats.
 * @returns The API and a counter of the calls.
 */
function scriptedApi(script: readonly Result<VideoStatus>[]): {
  api: AgentApi;
  calls: () => number;
} {
  let index = 0;
  const api: AgentApi = {
    claim: () => Promise.reject(new Error("not used")),
    session: () => Promise.reject(new Error("not used")),
    status: () => {
      const result = script[Math.min(index, script.length - 1)] ?? NETWORK;
      index += 1;
      return Promise.resolve(result);
    },
  };
  return { api, calls: () => index };
}

describe("startStatusPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports each good status and keeps polling", async () => {
    const { api, calls } = scriptedApi([OK]);
    const onStatus = vi.fn<(status: VideoStatus) => void>();
    const onLost = vi.fn<(reason: string) => void>();
    startStatusPoller({ api, sessionKey: SESSION_KEY, onStatus, onLost });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(onStatus).toHaveBeenCalledTimes(calls());
    expect(onStatus).toHaveBeenCalledWith(IDLE_STATUS);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("ignores four failures and recovers on the fifth poll", async () => {
    const { api } = scriptedApi([NETWORK, NETWORK, NETWORK, NETWORK, OK]);
    const onLost = vi.fn<(reason: string) => void>();
    const onStatus = vi.fn<(status: VideoStatus) => void>();
    startStatusPoller({ api, sessionKey: SESSION_KEY, onStatus, onLost });

    await vi.advanceTimersByTimeAsync(4_500);

    expect(onLost).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("gives up once after five failures in a row, and stops polling", async () => {
    const { api, calls } = scriptedApi([NETWORK]);
    const onLost = vi.fn<(reason: string) => void>();
    const onStatus = vi.fn<(status: VideoStatus) => void>();
    startStatusPoller({ api, sessionKey: SESSION_KEY, onStatus, onLost });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith("agent-unreachable");
    expect(calls()).toBe(5);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("gives up at once on a refused session key", async () => {
    const { api, calls } = scriptedApi([OK, UNAUTHORISED]);
    const onLost = vi.fn<(reason: string) => void>();
    startStatusPoller({ api, sessionKey: SESSION_KEY, onStatus: () => undefined, onLost });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith("unauthorised");
    expect(calls()).toBe(2);
  });

  it("stops quietly when the caller stops it", async () => {
    const { api, calls } = scriptedApi([OK]);
    const onLost = vi.fn<(reason: string) => void>();
    const stop = startStatusPoller({
      api,
      sessionKey: SESSION_KEY,
      onStatus: () => undefined,
      onLost,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    const before = calls();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls()).toBe(before);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("does not report a status that arrives after the caller stopped it", async () => {
    let resolveStatus: (result: Result<VideoStatus>) => void = () => undefined;
    const api: AgentApi = {
      claim: () => Promise.reject(new Error("not used")),
      session: () => Promise.reject(new Error("not used")),
      status: () =>
        new Promise<Result<VideoStatus>>((resolve) => {
          resolveStatus = resolve;
        }),
    };
    const onStatus = vi.fn<(status: VideoStatus) => void>();
    const stop = startStatusPoller({
      api,
      sessionKey: SESSION_KEY,
      onStatus,
      onLost: () => undefined,
    });

    stop();
    resolveStatus(OK);
    await vi.advanceTimersByTimeAsync(0);

    expect(onStatus).not.toHaveBeenCalled();
  });
});
