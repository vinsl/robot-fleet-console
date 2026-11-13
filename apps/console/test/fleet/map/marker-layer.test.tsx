/**
 * @vitest-environment jsdom
 *
 * The robot markers: one button per positioned robot that passes the filter, the translated names, the roving
 * focus with the arrow keys, and the click that opens a robot.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertRecord } from "@mfc/protocol";
import "../../../src/i18n";
import { fitContent, type PlaneGeometry } from "../../../src/fleet/map/projection";
import { MarkerLayer, nearestInDirection } from "../../../src/fleet/map/MarkerLayer";
import { useFleetStore } from "../../../src/live/fleet-store";
import { EMPTY_FILTER, useFleetFilterStore } from "../../../src/live/fleet-filter-store";
import { useWsStore } from "../../../src/ws/ws-store";
import { robotOf } from "../../live/support";

const { alertsState } = vi.hoisted(() => ({
  alertsState: { alerts: [] as readonly AlertRecord[] },
}));

vi.mock("../../../src/api/alerts", () => ({
  useActiveAlerts: () => ({ data: alertsState.alerts }),
}));

const PLANE: PlaneGeometry = {
  stageWidth: 1000,
  stageHeight: 800,
  planeLeft: 100,
  planeTop: 100,
  planeWidth: 800,
  planeHeight: 600,
  originX: 400,
  originY: 360,
  tiltRad: 0,
  perspectivePx: 1100,
};

const FRAME = fitContent({ minX: 0, minY: 0, width: 40, height: 20 }, 800, 600);

/**
 * Shows the current path, so that navigation can be asserted.
 *
 * @returns The path, in a paragraph.
 */
function PathProbe(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="path">{location.pathname}</p>;
}

/**
 * Renders the marker layer inside a router at a given address.
 *
 * @param path - The address to open.
 */
function renderLayer(path = "/"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <MarkerLayer frame={FRAME} view={{ zoom: 1, panX: 0, panY: 0 }} plane={PLANE} />
              <PathProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** Three robots inside the map, one without a pose. */
function seedRobots(): void {
  const now = Date.now();
  useFleetStore.setState({
    robots: {
      "sim-01": robotOf({
        robotId: "sim-01",
        state: "MOVING",
        pose: { x: 10, y: 10, heading: 0, speed: 0.5 },
        lastHeardAt: now,
      }),
      "sim-02": robotOf({
        robotId: "sim-02",
        state: "IDLE",
        pose: { x: 30, y: 10, heading: 0, speed: 0 },
        lastHeardAt: now,
      }),
      "sim-03": robotOf({
        robotId: "sim-03",
        state: "BLOCKED",
        pose: { x: 10, y: 2, heading: 0, speed: 0 },
        lastHeardAt: now,
      }),
      "sim-04": robotOf({ robotId: "sim-04", state: "IDLE", pose: null, lastHeardAt: now }),
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useWsStore.setState({ connection: "open", lastMessageAt: null });
  useFleetFilterStore.setState({ filter: EMPTY_FILTER });
  alertsState.alerts = [];
  seedRobots();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useFleetStore.getState().reset(0);
});

describe("nearestInDirection", () => {
  const points = new Map([
    ["a", { x: 0, y: 0 }],
    ["right", { x: 50, y: 4 }],
    ["far-right", { x: 200, y: 0 }],
    ["below", { x: 2, y: 60 }],
  ]);

  it("picks the closest marker in the direction", () => {
    expect(nearestInDirection(points, "a", "right")).toBe("right");
    expect(nearestInDirection(points, "a", "down")).toBe("below");
  });

  it("returns null when no marker lies in the direction", () => {
    expect(nearestInDirection(points, "a", "up")).toBeNull();
    expect(nearestInDirection(points, "missing", "right")).toBeNull();
  });

  it("counts a sideways offset twice, so a straight neighbour wins over a closer diagonal one", () => {
    const candidates = new Map([
      ["from", { x: 0, y: 0 }],
      ["diagonal", { x: 30, y: 25 }],
      ["straight", { x: 40, y: 0 }],
    ]);
    expect(nearestInDirection(candidates, "from", "right")).toBe("straight");
  });
});

describe("MarkerLayer", () => {
  it("renders one button per positioned robot, named with the translated state and battery", () => {
    renderLayer();
    const group = screen.getByRole("group", { name: "Robots on the map" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "sim-01, Moving, battery 80.0 %",
      "sim-02, Idle, battery 80.0 %",
      "sim-03, Blocked, battery 80.0 %",
    ]);
  });

  it("does not render a robot that has never been positioned", () => {
    renderLayer();
    expect(screen.queryByRole("button", { name: /sim-04/ })).toBeNull();
  });

  it("hides the robots that the filter excludes, and says how many", () => {
    useFleetFilterStore.setState({ filter: { ...EMPTY_FILTER, text: "sim-02" } });
    renderLayer();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("2 robots hidden by the filters")).toBeTruthy();
  });

  it("gives one marker the tab stop, and moves the focus with the arrow keys", () => {
    renderLayer();
    const first = screen.getByRole("button", { name: /sim-01/ });
    const second = screen.getByRole("button", { name: /sim-02/ });
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
  });

  it("opens the robot on click", () => {
    renderLayer();
    fireEvent.click(screen.getByRole("button", { name: /sim-02/ }));
    expect(screen.getByTestId("path").textContent).toBe("/robots/sim-02");
  });

  it("marks the open robot as the current one", () => {
    renderLayer("/robots/sim-03");
    expect(screen.getByRole("button", { name: /sim-03/ }).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("says a stale robot was last seen, with its age", () => {
    useFleetStore.setState({
      robots: {
        "sim-01": robotOf({
          robotId: "sim-01",
          state: "MOVING",
          pose: { x: 10, y: 10, heading: 0, speed: 0 },
          lastHeardAt: Date.now() - 6_000,
        }),
      },
    });
    renderLayer();
    expect(screen.getByRole("button", { name: /last seen/ })).toBeTruthy();
  });

  it("advances the position on each animation frame without a React render", async () => {
    renderLayer();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const marker = screen.getByRole("button", { name: /sim-01/ });
    expect(marker.style.transform).toContain("translate3d(");
  });

  it("places twenty robots in one animation frame, scheduling one loop per frame", () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      queue.push(callback);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const robots = Object.fromEntries(
      Array.from({ length: 20 }, (_unused, index) => {
        const robotId = `sim-${String(index + 1).padStart(2, "0")}`;
        const robot = robotOf({
          robotId,
          state: "MOVING",
          pose: { x: index, y: 2, heading: 0, speed: 0.5 },
          lastHeardAt: Date.now(),
        });
        return [robotId, robot] as const;
      }),
    );
    useFleetStore.setState({ robots });
    renderLayer();
    expect(screen.getAllByRole("button")).toHaveLength(20);
    const scheduled = queue.splice(0);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.(performance.now());
    expect(queue).toHaveLength(1);
    for (const marker of screen.getAllByRole("button")) {
      expect(marker.style.transform).toContain("translate3d(");
    }
  });
});
