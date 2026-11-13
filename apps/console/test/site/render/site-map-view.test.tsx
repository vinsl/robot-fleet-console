/**
 * @vitest-environment jsdom
 *
 * Read-only site map drawing and its legend: the image is named, every feature is drawn with a shape and a text
 * label, and an empty map draws without a failure.
 */
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSiteMap, type SiteMap } from "@mfc/protocol";
import "../../../src/i18n";
import { MapLegend } from "../../../src/site/render/MapLegend";
import {
  featureLayers,
  HATCH_STROKE_UNITS,
  LABEL_HALO_UNITS,
  LABEL_SIZE_UNITS,
  markerUnit,
  type FeatureLayers,
} from "../../../src/site/render/map-geometry";
import { SiteMapView } from "../../../src/site/render/SiteMapView";

const SAMPLE = parseSiteMap(
  readFileSync("../../packages/protocol/test/fixtures/site-map/sample-warehouse.geojson", "utf8"),
);

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("SiteMapView", () => {
  it("is a named image of the plan", () => {
    render(<SiteMapView layers={featureLayers(SAMPLE)} label="Warehouse plan" />);
    expect(screen.getByRole("img", { name: "Warehouse plan" })).toBeTruthy();
  });

  it("is a named group when it holds controls, so the controls stay in the accessibility tree", () => {
    render(
      <SiteMapView layers={featureLayers(SAMPLE)} label="Warehouse plan">
        <circle cx={0} cy={0} r={1} role="button" aria-label="Charger at 0 m" />
      </SiteMapView>,
    );
    const group = screen.getByRole("group", { name: "Warehouse plan" });
    expect(within(group).getByRole("button", { name: "Charger at 0 m" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws each wall, obstacle and no-go zone as one path", () => {
    const { container } = render(
      <SiteMapView layers={featureLayers(SAMPLE)} label="Warehouse plan" />,
    );
    // The sample has one wall, three obstacles and one no-go zone; the hatch pattern holds a line, not a path.
    expect(container.querySelectorAll("svg > g > path")).toHaveLength(5);
  });

  it("labels the charger and every workstation with text, not only with a shape", () => {
    render(<SiteMapView layers={featureLayers(SAMPLE)} label="Warehouse plan" />);
    const image = screen.getByRole("img", { name: "Warehouse plan" });
    const labels = within(image)
      .getAllByText(/./, { selector: "text" })
      .map((node) => node.textContent);
    expect(labels).toEqual(["Charger", "dock-a", "dock-b", "pack-c", "pack-d"]);
  });

  it("draws one square per workstation", () => {
    const { container } = render(
      <SiteMapView layers={featureLayers(SAMPLE)} label="Warehouse plan" />,
    );
    expect(container.querySelectorAll("svg > g > g > rect")).toHaveLength(4);
  });

  it("frames an empty map in the fixed plan size", () => {
    const empty: SiteMap = {
      type: "FeatureCollection",
      fleet: { crs: "local-metric", version: 1 },
      features: [],
    };
    render(<SiteMapView layers={featureLayers(empty)} label="Empty plan" />);
    const image = screen.getByRole("img", { name: "Empty plan" });
    expect(image.getAttribute("viewBox")).toBe("0 0 10 10");
  });
});

/**
 * A plan 60 m wide, so that one marker unit is exactly one metre, with a point marker and a sized workstation.
 *
 * @returns The grouped features.
 */
function sixtyMetrePlan(): FeatureLayers {
  return {
    walls: [
      [
        [0, 0],
        [60, 0],
      ],
    ],
    obstacles: [],
    nogo: [
      [
        [10, 20],
        [14, 20],
        [14, 22],
        [10, 22],
      ],
    ],
    charger: [0, 0],
    workstations: [
      { name: "dock-a", at: [30, 10], size: null },
      { name: "pack-b", at: [45, 10], size: { width: 4, height: 2 } },
    ],
  };
}

describe("SiteMapView rendering", () => {
  it("draws the label halo in marker units, thinner than the glyphs (regression: black blobs)", () => {
    const layers = sixtyMetrePlan();
    const unit = markerUnit(layers);
    const { container } = render(<SiteMapView layers={layers} label="Warehouse plan" />);
    const texts = Array.from(container.querySelectorAll("text"));
    expect(texts).toHaveLength(3);
    for (const text of texts) {
      const halo = Number(text.getAttribute("stroke-width"));
      const font = Number(text.getAttribute("font-size"));
      expect(halo).toBeCloseTo(unit * LABEL_HALO_UNITS);
      expect(font).toBeCloseTo(unit * LABEL_SIZE_UNITS);
      expect(halo).toBeLessThan(0.5 * font);
    }
  });

  it("draws the hatch lines in marker units, not as a solid slab", () => {
    const layers = sixtyMetrePlan();
    const unit = markerUnit(layers);
    const { container } = render(<SiteMapView layers={layers} label="Warehouse plan" />);
    const hatch = container.querySelector("pattern line");
    expect(Number(hatch?.getAttribute("stroke-width"))).toBeCloseTo(unit * HATCH_STROKE_UNITS);
    expect(Number(hatch?.getAttribute("stroke-width"))).toBeLessThan(unit / 2);
  });

  it("draws the footprint of a sized workstation under its marker, and a point marker alone", () => {
    const { container } = render(<SiteMapView layers={sixtyMetrePlan()} label="Warehouse plan" />);
    // The footprint has the size of the workstation, drawn in metres.
    const footprint = container.querySelectorAll('rect[width="4"][height="2"]');
    expect(footprint).toHaveLength(1);
    // Each workstation has its own marker square, so a sized one draws two squares and a point one draws one.
    expect(container.querySelectorAll("svg > g > g > rect")).toHaveLength(3);
  });
});

describe("MapLegend", () => {
  it("names every feature kind in text beside its shape", () => {
    render(<MapLegend />);
    const list = screen.getByRole("list", { name: "Map legend" });
    const items = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Wall", "Obstacle", "No-go zone", "Charger", "Workstation"]);
  });
});
