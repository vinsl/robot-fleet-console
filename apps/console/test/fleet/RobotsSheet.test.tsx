/**
 * @vitest-environment jsdom
 *
 * The robot list: filters by identifier, state and alert, the empty and none states, the search focus on arrival
 * from `/` or Ctrl/Cmd+K, and the robot cell that opens the robot page.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEMO_SITE_ID } from "@mfc/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import "../../src/i18n";
import { activeAlertsKey } from "../../src/api/alerts";
import { createServices } from "../../src/app/create-services";
import { ServicesProvider } from "../../src/app/services";
import { createQueryClient } from "../../src/app/query-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { RobotsSheet } from "../../src/fleet/robots/RobotsSheet";
import { useFleetFilterStore } from "../../src/live/fleet-filter-store";
import { useFleetStore } from "../../src/live/fleet-store";
import { useWsStore } from "../../src/ws/ws-store";
import { resetConsole, TEST_CONFIG } from "../support/console-harness";
import { alertOf, robotOf } from "../live/support";

/**
 * Seeds the live fleet (three robots, or none) and the active alerts, then renders the sheet at an address.
 *
 * @param path - The address, for example `/robots?focus=search`.
 * @param alerts - Overrides of the active alerts of the site.
 * @param empty - `true` for a fleet where no robot has reported.
 */
function renderSheet(
  path: string,
  alerts: readonly Record<string, unknown>[] = [],
  empty = false,
): void {
  const now = Date.now();
  const robots = empty
    ? []
    : [
        robotOf({ robotId: "sim-02", state: "MOVING", battery: 80, lastHeardAt: now }),
        robotOf({ robotId: "sim-01", state: "IDLE", battery: 12, lastHeardAt: now }),
        robotOf({ robotId: "sim-03", state: "BLOCKED", battery: 60, lastHeardAt: now }),
      ];
  useFleetStore.setState({
    robots: Object.fromEntries(robots.map((robot) => [robot.robotId, robot])),
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    activeAlertsKey(DEMO_SITE_ID),
    alerts.map((overrides) => alertOf(overrides)),
  );
  const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
  render(
    <ServicesProvider value={services}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/robots" element={<RobotsSheet />} />
            <Route path="/robots/:robotId" element={<p>Robot page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ServicesProvider>,
  );
}

/**
 * Lists the identifiers of the robots shown in the table, in order.
 *
 * @returns The identifiers.
 */
function shownRobots(): (string | null)[] {
  return screen.queryAllByRole("button", { name: /^Open / }).map((button) => button.textContent);
}

beforeEach(() => {
  resetConsole();
  useFleetFilterStore.getState().clear();
  useFleetStore.getState().reset(Date.now());
  useWsStore.setState({ connection: "open" });
});

afterEach(() => {
  cleanup();
});

describe("RobotsSheet", () => {
  it("lists every robot sorted by identifier, with the count caption", () => {
    renderSheet("/robots");
    expect(shownRobots()).toEqual(["sim-01", "sim-02", "sim-03"]);
    expect(screen.queryByText("3 of 3 robots")).not.toBeNull();
  });

  it("filters by identifier text, ignoring case", () => {
    renderSheet("/robots");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by id" }), {
      target: { value: "SIM-02" },
    });
    expect(shownRobots()).toEqual(["sim-02"]);
  });

  it("filters by state and combines the state with the text", () => {
    renderSheet("/robots");
    fireEvent.click(screen.getByRole("checkbox", { name: "Blocked" }));
    expect(shownRobots()).toEqual(["sim-03"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by id" }), {
      target: { value: "sim-01" },
    });
    expect(screen.queryByText("No robot matches the filters.")).not.toBeNull();
  });

  it("keeps only the robots with an open alert when the alert filter is set", () => {
    renderSheet("/robots", [{ robotId: "sim-03", kind: "BLOCKED" }]);
    fireEvent.click(screen.getByRole("checkbox", { name: "With open alert" }));
    expect(shownRobots()).toEqual(["sim-03"]);
    const row = screen.getByRole("button", { name: "Open sim-03" }).closest("tr");
    expect(row).not.toBeNull();
    if (row !== null) {
      expect(within(row).queryByText("Major")).not.toBeNull();
    }
  });

  it("clears every criterion with the clear button", () => {
    renderSheet("/robots");
    const search = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search by id" });
    fireEvent.change(search, { target: { value: "sim-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search.value).toBe("");
    expect(shownRobots()).toHaveLength(3);
  });

  it("focuses the search field when the address asks for it", () => {
    renderSheet("/robots?focus=search");
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search by id" }));
  });

  it("says that no robot has reported yet when the fleet is empty", () => {
    renderSheet("/robots", [], true);
    expect(screen.queryByText("No robot has reported yet.")).not.toBeNull();
  });

  it("opens the robot page from the robot cell", () => {
    renderSheet("/robots");
    fireEvent.click(screen.getByRole("button", { name: "Open sim-02" }));
    expect(screen.queryByText("Robot page")).not.toBeNull();
  });
});
