/**
 * @vitest-environment jsdom
 *
 * The state history: the pure rules (changes only, window, cap) and the list the panel draws from them.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RobotState } from "@mfc/protocol";
import "../../src/i18n";
import { StateTimeline } from "../../src/robot/StateTimeline";
import {
  TIMELINE_CAPACITY,
  TIMELINE_WINDOW_MS,
  appendState,
  type TimelineEntry,
} from "../../src/robot/timeline";

afterEach(() => {
  cleanup();
});

describe("appendState", () => {
  it("timeline-appends-only-changes: an unchanged state returns the same history", () => {
    const first = appendState([], "MOVING", 1_000);
    const again = appendState(first, "MOVING", 2_000);

    expect(again).toBe(first);
    expect(appendState(first, "IDLE", 3_000)).toEqual([
      { state: "MOVING", atMs: 1_000 },
      { state: "IDLE", atMs: 3_000 },
    ]);
  });

  it("drops entries older than the window when the state changes", () => {
    const history = appendState(appendState([], "MOVING", 0), "IDLE", 500_000);

    const later = appendState(history, "BLOCKED", TIMELINE_WINDOW_MS + 1);

    expect(later.map((entry) => entry.state)).toEqual(["IDLE", "BLOCKED"]);
  });

  it("keeps at most the capacity, the most recent entries", () => {
    let history: readonly TimelineEntry[] = [];
    const states: RobotState[] = ["MOVING", "IDLE"];
    for (let index = 0; index < TIMELINE_CAPACITY + 5; index += 1) {
      history = appendState(history, states[index % 2] ?? "MOVING", index);
    }

    expect(history).toHaveLength(TIMELINE_CAPACITY);
    expect(history[history.length - 1]?.atMs).toBe(TIMELINE_CAPACITY + 4);
  });
});

describe("StateTimeline", () => {
  it("draws one line per recorded change, not one per render", () => {
    const { container, rerender } = render(<StateTimeline state="MOVING" />);
    expect(container.querySelectorAll("li")).toHaveLength(1);

    rerender(<StateTimeline state="MOVING" />);
    expect(container.querySelectorAll("li")).toHaveLength(1);

    rerender(<StateTimeline state="IDLE" />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("Idle");
  });
});
