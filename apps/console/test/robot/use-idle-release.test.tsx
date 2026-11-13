/**
 * @vitest-environment jsdom
 *
 * Idle release of the lock: the timer, its reset by input, and the single call.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_IDLE_RELEASE_MS } from "@mfc/protocol";
import { useIdleRelease } from "../../src/control/use-idle-release";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useIdleRelease", () => {
  it("idle-release-after-30-min: calls once when the idle time passes", () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleRelease(true, onIdle);
    });

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS - 1);
    });
    expect(onIdle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("idle-resets-on-input: a key press restarts the idle time", () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleRelease(true, onIdle);
    });

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS - 1_000);
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS - 1_000);
    });
    expect(onIdle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive", () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleRelease(false, onIdle);
    });

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS * 2);
    });
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("re-arms while the lock is still held after a release that did not take it", async () => {
    const onIdle = vi.fn(() => Promise.resolve());
    renderHook(() => {
      useIdleRelease(true, onIdle);
    });

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });
    await act(() => Promise.resolve());
    expect(onIdle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("re-arms after a rejected release while the lock is still held", async () => {
    const onIdle = vi.fn(() => Promise.reject(new Error("network")));
    renderHook(() => {
      useIdleRelease(true, onIdle);
    });

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });
    await act(() => Promise.resolve());
    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });

    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("does not re-arm once the lock is no longer held", async () => {
    const onIdle = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      ({ active }) => {
        useIdleRelease(active, onIdle);
      },
      { initialProps: { active: true } },
    );

    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS);
    });
    rerender({ active: false });
    await act(() => Promise.resolve());
    act(() => {
      vi.advanceTimersByTime(CONSOLE_IDLE_RELEASE_MS * 2);
    });

    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
