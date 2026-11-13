/**
 * @vitest-environment jsdom
 *
 * The fleet map: no-map and failed-download notices without markers, the retry, the flat switch with its pressed
 * state, the keyboard zoom, and the focus request. The site query, the geometry and the alerts are stubbed; the
 * map itself is real.
 */
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSiteMap, type SiteMap } from "@mfc/protocol";
import "../../../src/i18n";
import { ApiError } from "../../../src/api/http-client";
import type { PlaneGeometry } from "../../../src/fleet/map/projection";
import { FleetMap } from "../../../src/fleet/map/FleetMap";
import { useFleetStore } from "../../../src/live/fleet-store";
import { useSelectionStore } from "../../../src/live/selection-store";
import { EMPTY_FILTER, useFleetFilterStore } from "../../../src/live/fleet-filter-store";
import { useWsStore } from "../../../src/ws/ws-store";
import { robotOf } from "../../live/support";

/** The part of the site query that the map reads. */
interface SiteQueryStub {
  data: SiteMap | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

/** The state of the site query, replaced by each test. */
const { siteQuery } = vi.hoisted(() => {
  const stub: SiteQueryStub = {
    data: undefined,
    isError: false,
    error: null,
    refetch: () => Promise.resolve(),
  };
  return { siteQuery: stub };
});

vi.mock("../../../src/site/use-site-map", () => ({
  useSiteMap: () => siteQuery,
}));

vi.mock("../../../src/api/alerts", () => ({
  useActiveAlerts: () => ({ data: [] }),
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

// The geometry needs a layout, which jsdom does not do: the tilt and the plane are fixed here.
vi.mock("../../../src/fleet/map/geometry-hooks", () => ({
  usePlaneGeometry: () => PLANE,
  useCompactTilt: () => false,
}));

const SAMPLE = parseSiteMap(
  readFileSync("../../packages/protocol/test/fixtures/site-map/sample-warehouse.geojson", "utf8"),
);

/**
 * Renders the map inside a router, as the shell does.
 */
function renderMap(): void {
  render(
    <MemoryRouter>
      <FleetMap />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  siteQuery.data = undefined;
  siteQuery.isError = false;
  siteQuery.error = null;
  siteQuery.refetch = vi.fn(() => Promise.resolve());
  useWsStore.setState({ connection: "open", lastMessageAt: null });
  useFleetFilterStore.setState({ filter: EMPTY_FILTER });
  useFleetStore.getState().reset(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FleetMap without a plan", () => {
  it("shows the placeholder and no markers while the plan loads", () => {
    renderMap();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("group", { name: "Map controls" })).toBeNull();
  });

  it("says there is no active map, without a retry, when the site has none (404)", () => {
    siteQuery.isError = true;
    siteQuery.error = new ApiError("request", 404, null);
    renderMap();
    expect(screen.getByRole("status").textContent).toContain("No active site map");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry when the download failed, and asks again on click", () => {
    siteQuery.isError = true;
    siteQuery.error = new ApiError("network", null, null);
    renderMap();
    expect(screen.getByRole("status").textContent).toContain("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(siteQuery.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("FleetMap with a plan", () => {
  beforeEach(() => {
    siteQuery.data = SAMPLE;
  });

  it("is a named group that holds the plan as a named image", () => {
    renderMap();
    expect(screen.getByRole("group", { name: "Warehouse map" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Warehouse map" })).toBeTruthy();
  });

  it("shows the controls, and the flat switch reports its pressed state", () => {
    renderMap();
    const flat = screen.getByRole("button", { name: "Flat view" });
    expect(flat.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(flat);
    expect(flat.getAttribute("aria-pressed")).toBe("true");
  });

  it("zooms with the + key while the map has the focus", () => {
    renderMap();
    const stage = screen.getByRole("group", { name: "Warehouse map" });
    const content = screen.getByRole("img", { name: "Warehouse map" }).parentElement;
    expect(content?.style.transform).toContain("scale(1)");
    fireEvent.keyDown(stage, { key: "+" });
    expect(content?.style.transform).toContain("scale(1.25)");
  });

  it("keeps the stage out of the tab order, so the shell keeps its keyboard order", () => {
    renderMap();
    const stage = screen.getByRole("group", { name: "Warehouse map" });
    expect(stage.tabIndex).toBe(-1);
  });

  it("zooms with the + key pressed on a control of the map", () => {
    renderMap();
    const content = screen.getByRole("img", { name: "Warehouse map" }).parentElement;
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom in" }), { key: "+" });
    expect(content?.style.transform).toContain("scale(1.25)");
  });

  it("draws the robots on the plan", () => {
    useFleetStore.setState({
      robots: {
        "sim-01": robotOf({
          robotId: "sim-01",
          state: "IDLE",
          pose: { x: 1, y: 1, heading: 0, speed: 0 },
          lastHeardAt: Date.now(),
        }),
      },
    });
    renderMap();
    expect(screen.getByRole("button", { name: /sim-01/ })).toBeTruthy();
  });

  it("jumps to a focused robot when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    useFleetStore.setState({
      robots: {
        "sim-01": robotOf({
          robotId: "sim-01",
          state: "IDLE",
          pose: { x: 20, y: 5, heading: 0, speed: 0 },
          lastHeardAt: Date.now(),
        }),
      },
    });
    renderMap();
    const content = screen.getByRole("img", { name: "Warehouse map" }).parentElement;
    const before = content?.style.transform;
    useSelectionStore.getState().requestFocus("sim-01");
    await waitFor(() => {
      expect(content?.style.transform).not.toBe(before);
    });
  });
});
