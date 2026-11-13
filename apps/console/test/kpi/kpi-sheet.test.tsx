/**
 * @vitest-environment jsdom
 *
 * The KPI sheet: the two time-window groups, the single partial note, the hero numbers with their units, the
 * no-data and warm-up states, and the French rendering. The values come from a mocked hook, so each state is set
 * up directly.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import "../../src/i18n";
import { KpiSheet } from "../../src/kpi/KpiSheet";
import type { KpiValues } from "../../src/kpi/kpi";
import { useKpis, type KpiSnapshot } from "../../src/kpi/use-kpis";

vi.mock("../../src/kpi/use-kpis", () => ({ useKpis: vi.fn() }));

/** The session start the snapshots carry. The time it shows is local, so the tests only match its shape. */
const SESSION_START = Date.parse("2026-11-04T09:30:00.000Z");

/** Full values: every KPI computed, with the alert history complete. */
const COMPLETE: KpiValues = {
  availability: 0.964,
  missions: { perHour: 12.5, count: 25, minutes: 60 },
  errorRate: 0.04,
  interventions: 1.5,
  mttrMs: 600_000,
};

/**
 * Builds the hook result of one test.
 *
 * @param values - The KPI values, overriding the complete set.
 * @param partial - Whether the alert history is incomplete.
 * @returns The snapshot the sheet reads.
 */
function snapshot(values: Partial<KpiValues> = {}, partial = false): KpiSnapshot {
  return {
    values: { ...COMPLETE, ...values },
    partial,
    sessionStartedAt: SESSION_START,
  };
}

/**
 * Renders the sheet inside a router, as the console does.
 */
function renderSheet(): void {
  render(
    <MemoryRouter>
      <KpiSheet />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(useKpis).mockReturnValue(snapshot());
});

afterEach(() => {
  cleanup();
  vi.mocked(useKpis).mockReset();
});

describe("KpiSheet groups", () => {
  it("names the two time windows as group headings", () => {
    renderSheet();
    expect(
      screen.getByRole("heading", { level: 3, name: /^This session, since .+$/ }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Last 24 h" })).toBeTruthy();
  });

  it("puts the session KPIs in the session group and the alert KPIs in the 24-hour group", () => {
    renderSheet();
    const session = screen.getByRole("region", { name: /^This session, since .+$/ });
    const day = screen.getByRole("region", { name: "Last 24 h" });
    for (const name of ["Availability", "Missions/h", "Error rate"]) {
      expect(within(session).getByRole("heading", { level: 4, name })).toBeTruthy();
    }
    for (const name of ["Interventions per robot", "MTTR"]) {
      expect(within(day).getByRole("heading", { level: 4, name })).toBeTruthy();
    }
  });

  it("shows the partial notice once, in the 24-hour group", () => {
    vi.mocked(useKpis).mockReturnValue(snapshot({}, true));
    renderSheet();
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe("Alert history incomplete");
    const day = screen.getByRole("region", { name: "Last 24 h" });
    expect(within(day).getByRole("note").textContent).toBe("Alert history incomplete");
  });

  it("shows no notice when the alert history is complete", () => {
    renderSheet();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("KpiSheet values", () => {
  it("shows the percentages with the unit set apart from the digits", () => {
    renderSheet();
    const availability = screen.getByRole("region", { name: "Availability" });
    expect(availability.textContent).toContain("96%");
    expect(within(availability).getByText("%").tagName).toBe("SPAN");
  });

  it("shows the missions rate with its unit", () => {
    renderSheet();
    const missions = screen.getByRole("region", { name: "Missions/h" });
    expect(missions.textContent).toContain("12.5/h");
    expect(within(missions).getByText("/h").tagName).toBe("SPAN");
  });

  it("shows the no-data line in the card when a value cannot be computed yet", () => {
    vi.mocked(useKpis).mockReturnValue(snapshot({ errorRate: null, mttrMs: null }));
    renderSheet();
    const errorRate = screen.getByRole("region", { name: "Error rate" });
    expect(within(errorRate).getByText("No data yet")).toBeTruthy();
    const mttr = screen.getByRole("region", { name: "MTTR" });
    expect(within(mttr).getByText("No data yet")).toBeTruthy();
  });

  it("shows the count and the window during warm-up, and when the rate appears", () => {
    vi.mocked(useKpis).mockReturnValue(
      snapshot({ missions: { perHour: null, count: 3, minutes: 12 } }),
    );
    renderSheet();
    const missions = screen.getByRole("region", { name: "Missions/h" });
    expect(within(missions).getByText("3")).toBeTruthy();
    expect(within(missions).getByText("in 12 min")).toBeTruthy();
    expect(within(missions).getByText("Rate shown after 5 min")).toBeTruthy();
  });
});

describe("KpiSheet in French", () => {
  it("renders the French headings, units and notice", async () => {
    await i18n.changeLanguage("fr");
    vi.mocked(useKpis).mockReturnValue(snapshot({}, true));
    renderSheet();
    expect(
      screen.getByRole("heading", { level: 3, name: /^Cette session, depuis .+$/ }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "24 dernières heures" })).toBeTruthy();
    const availability = screen.getByRole("region", { name: "Disponibilité" });
    expect(availability.textContent).toContain("96%");
    const missions = screen.getByRole("region", { name: "Missions/h" });
    expect(missions.textContent).toContain("12,5/h");
    expect(screen.getByRole("note").textContent).toBe("Historique des alertes incomplet");
  });
});
