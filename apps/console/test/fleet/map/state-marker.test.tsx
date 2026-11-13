/**
 * @vitest-environment jsdom
 *
 * The robot graphic: each state has its own shape and glyph, the detail level drops only the icon, and the graphic
 * is hidden from assistive technology (the button carries the name).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StateMarker } from "../../../src/fleet/map/StateMarker";
import { STATE_VISUALS } from "../../../src/theme/robot-state-visuals";
import type { RobotState } from "@mfc/protocol";

afterEach(() => {
  cleanup();
});

const STATES = Object.keys(STATE_VISUALS) as RobotState[];

describe("StateMarker", () => {
  it.each(STATES)("draws the shape and glyph of %s from the state visuals", (state) => {
    // eslint-disable-next-line security/detect-object-injection -- RobotState is a closed protocol enum, the table is keyed by it
    const visual = STATE_VISUALS[state];
    const { container } = render(
      <StateMarker state={state} badges={[]} selected={false} detail stale={false} />,
    );
    const root = container.querySelector("[data-shape]");
    expect(root?.getAttribute("data-shape")).toBe(visual.shape);
    if (visual.markerGlyph === "icon") {
      // The icon is a Lucide SVG nested in the marker SVG.
      expect(container.querySelectorAll("svg svg").length).toBe(1);
    }
    if (visual.markerGlyph === "dot") {
      expect(container.querySelector('circle[r="2.5"]')).not.toBeNull();
    }
    if (visual.markerGlyph === "exclamation") {
      expect(container.querySelector('path[d="M12 8.5v5"]')).not.toBeNull();
    }
  });

  it("drops only the icon at a low zoom, keeping the shape", () => {
    const { container } = render(
      <StateMarker state="MOVING" badges={[]} selected={false} detail={false} stale={false} />,
    );
    expect(container.querySelector("svg svg")).toBeNull();
    expect(container.querySelector("[data-shape='circle']")).not.toBeNull();
  });

  it("adds the stale class to a stale marker", () => {
    const { container } = render(
      <StateMarker state="IDLE" badges={[]} selected={false} detail stale />,
    );
    expect(container.querySelector("[data-shape]")?.className).toContain("stale");
  });

  it("is hidden from assistive technology", () => {
    const { container } = render(
      <StateMarker state="BLOCKED" badges={["lowBattery"]} selected={false} detail stale={false} />,
    );
    expect(container.querySelector("[data-shape]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders one badge per kind, in the given order", () => {
    const { container } = render(
      <StateMarker
        state="MOVING"
        badges={["lowBattery", "stale"]}
        selected={false}
        detail
        stale={false}
      />,
    );
    expect(container.querySelectorAll("[data-shape] > span > span")).toHaveLength(2);
  });
});
