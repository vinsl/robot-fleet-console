// @vitest-environment jsdom
/**
 * The shell subscribes to the live fleet through the online count only, so a robot delta that leaves the count
 * unchanged does not re-render it.
 */
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presenceOf, deltaOf, sampleOf } from "../live/support";
import { useFleetStore } from "../../src/live/fleet-store";
import { useWsStore } from "../../src/ws/ws-store";
import { Shell } from "../../src/layout/Shell";

const NOW = Date.parse("2026-11-03T10:00:00.000Z");

const { demoBanner } = vi.hoisted(() => ({ demoBanner: vi.fn(() => null) }));

const { statusLine } = vi.hoisted(() => ({
  statusLine: vi.fn<(props: { readonly robotsOnline: number | null }) => null>(() => null),
}));

vi.mock("../../src/layout/StatusLine", () => ({ StatusLine: statusLine }));
vi.mock("../../src/layout/Dock", () => ({ Dock: () => null }));
vi.mock("../../src/layout/MapStage", () => ({ MapStage: () => null }));
vi.mock("../../src/alerts/AlertPill", () => ({ AlertPill: () => null }));
vi.mock("../../src/alerts/AlertNotifier", () => ({ AlertNotifier: () => null }));
vi.mock("../../src/kpi/KpiCorners", () => ({ KpiCorners: () => null }));
// The banner is replaced by a spy: the assertion is that the shell mounts it, not what the banner draws.
vi.mock("../../src/demo/DemoBanner", () => ({ DemoBanner: demoBanner }));
vi.mock("../../src/api/health", () => ({ useApiHealth: () => undefined }));
vi.mock("../../src/layout/open-alerts", () => ({ useOpenAlertCount: () => null }));
vi.mock("../../src/live/alerts-feed", () => ({ useAlertFeed: () => undefined }));
vi.mock("../../src/live/alert-sound", () => ({
  alertSound: {},
  installAudioUnlock: () => () => undefined,
}));
vi.mock("../../src/app/services", () => ({
  useServices: () => ({ ws: { connect: () => undefined, close: () => undefined } }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  statusLine.mockClear();
  demoBanner.mockClear();
  useWsStore.setState({ connection: "open" });
  useFleetStore.getState().reset(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useWsStore.setState({ connection: "idle" });
});

describe("Shell live fleet subscription", () => {
  it("does not re-render on a robot delta that leaves the online count unchanged", () => {
    useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 1)]), NOW);
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    expect(statusLine.mock.lastCall?.[0].robotsOnline).toBe(1);
    const rendered = statusLine.mock.calls.length;

    act(() => {
      useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 2, { x: 5 })]), NOW + 10);
    });

    expect(statusLine.mock.calls.length).toBe(rendered);
  });

  it("re-renders when the online count changes", () => {
    useFleetStore.getState().applyFrame(deltaOf([sampleOf("sim-01", 1)]), NOW);
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    const rendered = statusLine.mock.calls.length;

    act(() => {
      useFleetStore.getState().applyFrame(presenceOf("sim-01", "OFFLINE"), NOW + 10);
    });

    expect(statusLine.mock.calls.length).toBeGreaterThan(rendered);
    expect(statusLine.mock.lastCall?.[0].robotsOnline).toBe(0);
  });

  it("mounts the demo banner inside the shell", () => {
    render(
      <MemoryRouter>
        <Shell />
      </MemoryRouter>,
    );
    expect(demoBanner).toHaveBeenCalled();
  });
});
