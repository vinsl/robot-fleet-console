/**
 * Small live stores: the fleet store publishes only real changes, the selection store makes repeated requests
 * distinct, and the frame bus delivers to subscribers until they unsubscribe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetStore } from "../../src/live/fleet-store";
import { publishFrame, subscribeFrames } from "../../src/live/frame-bus";
import { useSelectionStore } from "../../src/live/selection-store";
import { deltaOf, sampleOf } from "./support";

beforeEach(() => {
  useFleetStore.getState().reset(0);
  useSelectionStore.setState({ focus: null });
});

describe("useFleetStore", () => {
  it("publishes a delta that changed a robot", () => {
    useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 1)]), 10);
    expect(useFleetStore.getState().robots["sim-01"]?.state).toBe("MOVING");
  });

  it("keeps the same state object for an unchanged frame", () => {
    useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 1)]), 10);
    const before = useFleetStore.getState();
    useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 1)]), 20);
    expect(useFleetStore.getState()).toBe(before);
  });
});

describe("useSelectionStore", () => {
  it("gives every request a new nonce, even for the same robot", () => {
    useSelectionStore.getState().requestFocus("sim-02");
    const first = useSelectionStore.getState().focus;
    useSelectionStore.getState().requestFocus("sim-02");
    const second = useSelectionStore.getState().focus;
    expect(first).toEqual({ robotId: "sim-02", nonce: 1 });
    expect(second).toEqual({ robotId: "sim-02", nonce: 2 });
  });
});

describe("frame bus", () => {
  it("delivers to subscribers until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFrames(listener);
    const frame = { type: "error" as const, code: "INVALID_MESSAGE" as const };

    try {
      publishFrame(frame);
      unsubscribe();
      publishFrame(frame);
    } finally {
      // Removing a subscriber twice is harmless, and a failing expectation must not leak it to other cases.
      unsubscribe();
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(frame);
  });
});
