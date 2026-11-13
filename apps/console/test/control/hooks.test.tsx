/**
 * @vitest-environment jsdom
 *
 * Heartbeat, command send and the command clock, driven through the real hooks, stores and HTTP client.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommandStore } from "../../src/control/command-store";
import { useCommandExpiry } from "../../src/control/use-command-clock";
import { useHeartbeat } from "../../src/control/use-heartbeat";
import { useSendCommand } from "../../src/control/use-command";
import { ROBOT, createControlHarness, json, type RecordedRequest } from "./support";

/** Commands the fake API has received, in order. */
function commandPosts(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.path.endsWith("/commands"));
}

/**
 * The command identifier of a recorded request.
 *
 * @param request - The request.
 * @returns The identifier, or an empty string when the body has none.
 */
function commandIdOf(request: RecordedRequest): string {
  const body = request.body;
  return typeof body === "object" &&
    body !== null &&
    "commandId" in body &&
    typeof body.commandId === "string"
    ? body.commandId
    : "";
}

/** A command answer of the API, for a request whose identifier the test does not inspect. */
const ACCEPTED = {
  commandId: "0190f3a2-7b1c-7000-8000-000000000030",
  correlationId: "corr-0001-abcd",
  issuedAt: "2026-11-04T10:00:00.000Z",
  deduplicated: false,
};

/**
 * Answers a command request the way the API does: accepted, not a duplicate, with the identifier echoed back.
 *
 * @param request - The command request.
 * @returns The response.
 */
function acceptCommand(request: RecordedRequest): Response {
  return json(200, {
    commandId: commandIdOf(request),
    correlationId: "corr-0001-abcd",
    issuedAt: "2026-11-04T10:00:00.000Z",
    deduplicated: false,
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useCommandStore.getState().reset();
});

describe("heartbeat", () => {
  it("heartbeat-sends-4-per-second-while-active", async () => {
    const harness = createControlHarness(() => json(200, {}));
    const socket = await harness.openSocket();
    vi.useFakeTimers();

    renderHook(() => useHeartbeat(ROBOT, true), { wrapper: harness.wrapper() });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const beats = socket.sent.filter((text) => text.includes('"type":"heartbeat"'));
    expect(beats).toHaveLength(4);
    expect(beats[0]).toBe(JSON.stringify({ type: "heartbeat", robotId: ROBOT }));
  });

  it("heartbeat-stops-when-inactive", async () => {
    const harness = createControlHarness(() => json(200, {}));
    const socket = await harness.openSocket();
    vi.useFakeTimers();

    const { rerender } = renderHook(({ active }) => useHeartbeat(ROBOT, active), {
      initialProps: { active: true },
      wrapper: harness.wrapper(),
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(socket.sent.filter((text) => text.includes('"type":"heartbeat"'))).toHaveLength(2);
  });

  it("heartbeat-link-lost-flag: a heartbeat that cannot be sent clears linkOk and the timer keeps running", () => {
    const harness = createControlHarness(() => json(200, {}));
    vi.useFakeTimers();

    const { result } = renderHook(() => useHeartbeat(ROBOT, true), { wrapper: harness.wrapper() });
    expect(result.current.linkOk).toBe(true);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.linkOk).toBe(false);
  });

  it("given a link lost warning, when the heartbeat stops, then linkOk is true again", () => {
    const harness = createControlHarness(() => json(200, {}));
    vi.useFakeTimers();

    const { result, rerender } = renderHook(({ active }) => useHeartbeat(ROBOT, active), {
      initialProps: { active: true },
      wrapper: harness.wrapper(),
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.linkOk).toBe(false);

    rerender({ active: false });

    expect(result.current.linkOk).toBe(true);
  });
});

describe("command send", () => {
  it("command-failure-marks-failed: a request without an answer marks the command failed", async () => {
    const harness = createControlHarness(() => json(500, {}));
    const { result } = renderHook(() => useSendCommand(ROBOT), { wrapper: harness.wrapper() });

    await act(() => result.current.send({ type: "PAUSE" }));

    const entries = [...useCommandStore.getState().entries.values()];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("failed");
  });

  it("estop-one-click-new-command-id-each-press: two presses are two requests with two identifiers, not queued", async () => {
    let finishFirst: (response: Response) => void = () => undefined;
    const firstAnswer = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    let received = 0;
    const harness = createControlHarness((request) => {
      received += 1;
      return received === 1 ? firstAnswer : acceptCommand(request);
    });
    const { result } = renderHook(() => useSendCommand(ROBOT), { wrapper: harness.wrapper() });

    const first = result.current.send({ type: "ESTOP" });
    const second = result.current.send({ type: "ESTOP" });
    // The second press leaves before the first answer arrives: nothing waits for another request.
    await waitFor(() => {
      expect(commandPosts(harness.requests)).toHaveLength(2);
    });

    const [a, b] = commandPosts(harness.requests).map(commandIdOf);
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
    finishFirst(json(200, ACCEPTED));
    await Promise.all([first, second]);
  });
});

describe("command clock", () => {
  it("expires the pending commands once a second, after five seconds", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // Only the interval is faked: a fake `performance` would replace the clock the test controls.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    useCommandStore.getState().begin({
      commandId: "0190f3a2-7b1c-7000-8000-000000000020",
      robotId: ROBOT,
      type: "PAUSE",
      sentAt: 0,
    });
    renderHook(() => {
      useCommandExpiry();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect([...useCommandStore.getState().entries.values()][0]?.status).toBe("pending");

    clock = 5000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect([...useCommandStore.getState().entries.values()][0]?.status).toBe("no-answer");
  });
});
