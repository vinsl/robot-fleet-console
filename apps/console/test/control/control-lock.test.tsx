/**
 * @vitest-environment jsdom
 *
 * The robot lock as the panel uses it: the state it shows, taking it (with the single retry on a lock race),
 * giving it up, and the refetch after a conflict.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  COMMAND_ACK_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  type LockState,
  type WsServerMessage,
} from "@mfc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockKey } from "../../src/api/control";
import { useAuthStore } from "../../src/auth/auth-store";
import { useCommandStore } from "../../src/control/command-store";
import { useControlLock } from "../../src/control/use-control-lock";
import { isLockMine, useLockStore } from "../../src/control/lock-store";
import { useSendCommand } from "../../src/control/use-command";
import {
  ROBOT,
  SITE,
  SUB,
  OTHER_SUB,
  ackOf,
  createControlHarness,
  json,
  lockActionBody,
  lockState,
  type ControlHarness,
  type RecordedRequest,
} from "./support";

/** Fake clock for the timers of the lock flow only; `performance.now` stays real. */
const FAKE_TIMERS: { toFake: ("setTimeout" | "clearTimeout")[] } = {
  toFake: ["setTimeout", "clearTimeout"],
};

/**
 * Requests of one kind received by the fake API.
 *
 * @param harness - The harness.
 * @param method - HTTP method.
 * @param suffix - End of the path.
 * @returns The matching requests, in order.
 */
function requestsOf(harness: ControlHarness, method: string, suffix: string): RecordedRequest[] {
  return harness.requests.filter(
    (request) => request.method === method && request.path.endsWith(suffix),
  );
}

/**
 * The command identifiers of the requests of one kind.
 *
 * @param harness - The harness.
 * @param method - HTTP method.
 * @param suffix - End of the path.
 * @returns The identifiers, in order.
 */
function commandIdsOf(harness: ControlHarness, method: string, suffix: string): string[] {
  return requestsOf(harness, method, suffix).map((request) => {
    const body = request.body;
    return typeof body === "object" &&
      body !== null &&
      "commandId" in body &&
      typeof body.commandId === "string"
      ? body.commandId
      : "";
  });
}

/**
 * A harness whose lock answers are fixed: the state the GET reports and the answer to a take or a release.
 *
 * @param current - The lock state the GET reports.
 * @param action - The lock state the take or the release answers with.
 * @returns The harness.
 */
function lockHarness(current: LockState, action: LockState = current): ControlHarness {
  return createControlHarness((request) => {
    if (request.method === "GET") {
      return json(200, current);
    }
    if (request.method === "POST" && request.path.endsWith("/lock/release")) {
      return json(200, lockActionBody(action));
    }
    if (request.method === "POST" && request.path.endsWith("/lock")) {
      return json(200, lockActionBody(action));
    }
    return json(404, {});
  });
}

beforeEach(() => {
  useAuthStore.setState({ userId: SUB });
  useLockStore.setState({ locks: new Map() });
  useCommandStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("control lock state", () => {
  it("is free when nobody holds the lock", async () => {
    const harness = lockHarness(lockState(false));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });

    await waitFor(() => {
      expect(result.current.state).toBe("free");
    });
    expect(result.current.holderLabel).toBeUndefined();
  });

  it("is mine when the verified subject holds the lock", async () => {
    const harness = lockHarness(lockState(true, SUB));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });

    await waitFor(() => {
      expect(result.current.state).toBe("mine");
    });
  });

  it("is other, with the holder label, when another operator holds the lock", async () => {
    const harness = lockHarness(lockState(true, OTHER_SUB));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });

    await waitFor(() => {
      expect(result.current.state).toBe("other");
    });
    expect(result.current.holderLabel).toBe("Operator 5555");
  });
});

describe("taking and giving up the lock", () => {
  it("takes the lock and resolves with the robot's acknowledgement", async () => {
    const harness = lockHarness(lockState(false), lockState(true, SUB));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    // The first read of the lock must land before the take, or it would overwrite the take's answer.
    await waitFor(() => {
      expect(result.current.state).toBe("free");
    });

    const pending = result.current.acquire();
    await waitFor(() => {
      expect(commandIdsOf(harness, "POST", "/lock")).toHaveLength(1);
    });
    const [commandId] = commandIdsOf(harness, "POST", "/lock");
    act(() => {
      useCommandStore.getState().applyAck(ackOf(commandId ?? ""), performance.now());
    });

    await expect(pending).resolves.toBe("ack");
    expect(isLockMine(useLockStore.getState().locks.get(ROBOT), SUB)).toBe(true);
  });

  it("acquire-retries-once-on-not-lock-holder: a refusal is retried once, with a new identifier", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const harness = lockHarness(lockState(false), lockState(true, SUB));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await vi.waitFor(() => {
      expect(result.current.state).toBe("free");
    });

    const pending = result.current.acquire();
    await vi.waitFor(() => {
      expect(commandIdsOf(harness, "POST", "/lock")).toHaveLength(1);
    });
    const [first] = commandIdsOf(harness, "POST", "/lock");
    act(() => {
      useCommandStore.getState().applyAck(ackOf(first ?? "", "NOT_LOCK_HOLDER"), performance.now());
    });

    await vi.waitFor(
      () => {
        expect(commandIdsOf(harness, "POST", "/lock")).toHaveLength(2);
      },
      { timeout: LOCK_RETRY_DELAY_MS * 10 },
    );
    const [, second] = commandIdsOf(harness, "POST", "/lock");
    expect(second).not.toBe(first);
    act(() => {
      useCommandStore.getState().applyAck(ackOf(second ?? ""), performance.now());
    });

    await expect(pending).resolves.toBe("ack");
    expect(commandIdsOf(harness, "POST", "/lock")).toHaveLength(2);
  });

  it("resolves with no-answer when the robot does not answer the take in time", async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const harness = lockHarness(lockState(false), lockState(true, SUB));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await vi.waitFor(() => {
      expect(result.current.state).toBe("free");
    });

    const pending = result.current.acquire();
    await vi.waitFor(() => {
      expect(isLockMine(useLockStore.getState().locks.get(ROBOT), SUB)).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(COMMAND_ACK_TIMEOUT_MS);

    await expect(pending).resolves.toBe("no-answer");
  });

  it("acquire-failed-when-the-take-gets-no-answer-from-the-api: a conflict is failed and the lock is read again", async () => {
    const harness = createControlHarness((request) => {
      if (request.method === "GET") {
        return json(200, lockState(true, OTHER_SUB));
      }
      return json(409, {});
    });
    const { result } = renderHook(
      () => ({ lock: useControlLock(ROBOT), send: useSendCommand(ROBOT) }),
      {
        wrapper: harness.wrapper(),
      },
    );
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(1);
    });

    await expect(result.current.lock.acquire()).resolves.toBe("failed");
    expect([...useCommandStore.getState().entries.values()][0]?.status).toBe("failed");
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(2);
    });
  });

  it("lock-held-409-refetches-state: a conflict on a command reads the lock again", async () => {
    const harness = createControlHarness((request) =>
      request.method === "GET" ? json(200, lockState(true, OTHER_SUB)) : json(409, {}),
    );
    const { result } = renderHook(
      () => ({ send: useSendCommand(ROBOT), lock: useControlLock(ROBOT) }),
      {
        wrapper: harness.wrapper(),
      },
    );
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(1);
    });

    await act(() => result.current.send.send({ type: "PAUSE" }));

    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(2);
    });
  });

  it("release gives the lock up and the robot's answer is awaited on the socket", async () => {
    const harness = lockHarness(lockState(true, SUB), lockState(false));
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await waitFor(() => {
      expect(result.current.state).toBe("mine");
    });

    await act(() => result.current.release());

    expect(result.current.state).toBe("free");
    expect(commandIdsOf(harness, "POST", "/lock/release")).toHaveLength(1);
    expect(useCommandStore.getState().logByRobot.get(ROBOT)).toHaveLength(1);
  });

  it("given a take answer, when a late initial GET resolves, then a late initial GET after a take does not overwrite mine", async () => {
    let resolveGet: (() => void) | undefined;
    const harness = createControlHarness((request) => {
      if (request.method === "GET") {
        return new Promise<Response>((resolve) => {
          resolveGet = () => {
            resolve(json(200, lockState(false)));
          };
        });
      }
      return json(200, lockActionBody(lockState(true, SUB)));
    });
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(1);
    });

    const pending = result.current.acquire();
    await waitFor(() => {
      expect(result.current.state).toBe("mine");
    });
    act(() => {
      resolveGet?.();
    });
    await waitFor(() => {
      expect(harness.queryClient.getQueryState(lockKey(ROBOT))?.dataUpdateCount).toBeGreaterThan(0);
    });

    expect(result.current.state).toBe("mine");
    const [commandId] = commandIdsOf(harness, "POST", "/lock");
    act(() => {
      useCommandStore.getState().applyAck(ackOf(commandId ?? ""), performance.now());
    });
    await expect(pending).resolves.toBe("ack");
  });

  it("given a take answer, when the panel remounts and the cache holds an older read, then the lock stays mine", async () => {
    let answerGet: LockState = lockState(false);
    const harness = createControlHarness((request) => {
      if (request.method === "GET") {
        return json(200, answerGet);
      }
      return json(200, lockActionBody(lockState(true, SUB)));
    });
    const first = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await waitFor(() => {
      expect(first.result.current.state).toBe("free");
    });
    const pending = first.result.current.acquire();
    await waitFor(() => {
      expect(first.result.current.state).toBe("mine");
    });
    expect(harness.queryClient.getQueryData<LockState>(lockKey(ROBOT))?.held).toBe(true);
    const [commandId] = commandIdsOf(harness, "POST", "/lock");
    act(() => {
      useCommandStore.getState().applyAck(ackOf(commandId ?? ""), performance.now());
    });
    await expect(pending).resolves.toBe("ack");
    first.unmount();

    // The server now answers "free" for a read made after the take: the remount must still show mine.
    answerGet = lockState(false);
    const second = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });

    expect(second.result.current.state).toBe("mine");
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(2);
    });
    expect(second.result.current.state).toBe("mine");
  });

  it("given a lock.changed frame, when the initial GET resolves with a stale value, then the frame is not overwritten by the seed", async () => {
    let resolveGet: (() => void) | undefined;
    const harness = createControlHarness((request) => {
      if (request.method === "GET") {
        return new Promise<Response>((resolve) => {
          resolveGet = () => {
            resolve(json(200, lockState(false)));
          };
        });
      }
      return json(404, {});
    });
    const { result } = renderHook(() => useControlLock(ROBOT), { wrapper: harness.wrapper() });
    await waitFor(() => {
      expect(requestsOf(harness, "GET", "/lock")).toHaveLength(1);
    });

    const frame: WsServerMessage = {
      type: "lock.changed",
      siteId: SITE,
      robotId: ROBOT,
      held: true,
      holder: OTHER_SUB,
      cause: "ACQUIRED",
    };
    act(() => {
      useLockStore.getState().applyFrame(frame);
    });
    act(() => {
      resolveGet?.();
    });
    await waitFor(() => {
      expect(harness.queryClient.getQueryState(lockKey(ROBOT))?.dataUpdateCount).toBeGreaterThan(0);
    });

    expect(result.current.state).toBe("other");
    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: OTHER_SUB });
  });

  it("given a lock held by another operator, when a command is refused with a conflict, then the fresh lock state is applied", async () => {
    let current: LockState = lockState(false);
    const harness = createControlHarness((request) => {
      if (request.method === "GET") {
        return json(200, current);
      }
      return json(409, {});
    });
    const { result } = renderHook(
      () => ({ send: useSendCommand(ROBOT), lock: useControlLock(ROBOT) }),
      { wrapper: harness.wrapper() },
    );
    await waitFor(() => {
      expect(result.current.lock.state).toBe("free");
    });

    current = lockState(true, OTHER_SUB);
    await act(() => result.current.send.send({ type: "PAUSE" }));

    await waitFor(() => {
      expect(result.current.lock.state).toBe("other");
    });
  });
});
