/**
 * Site map contract: the committed sample parses, each invalid fixture fails for its stated reason, and
 * the size bounds refuse oversized text before any parsing.
 *
 * The two bounds that would make a committed fixture several megabytes are built in the test instead.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- the fixture folder is a fixed path of this test; no input reaches these reads */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SITE_MAP_MAX_BYTES, SiteMapSchema, parseSiteMap, type SiteMap } from "../src/index";

/** Root of the site map fixtures of this package's tests. */
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/site-map/", import.meta.url));

/** A point of the site frame, in metres. */
type Point = readonly [number, number];

/** A feature of a validated map. */
type MapFeature = SiteMap["features"][number];

/**
 * Clearance a station or the charger keeps from every barrier, in metres. A robot docks next to a
 * station, so the point must lie outside each barrier expanded by this distance.
 */
const STATION_CLEARANCE_M = 0.4;

/** A barrier of the map: a closed area (rack, no-go zone) or an open chain (wall). */
interface Barrier {
  readonly kind: string;
  readonly chains: readonly (readonly Point[])[];
  readonly area: boolean;
}

/** A station or the charger, with its kind for the messages. */
interface Station {
  readonly kind: string;
  readonly point: Point;
}

/**
 * Turns a feature into the barrier it forms. Points form no barrier.
 *
 * @param feature - A validated feature of the map.
 * @returns The barriers of the feature: one for a wall or an area, none for a point.
 */
function barrierOf(feature: MapFeature): Barrier[] {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "Polygon":
      return [{ kind: feature.properties.kind, chains: geometry.coordinates, area: true }];
    case "LineString":
      return [{ kind: feature.properties.kind, chains: [geometry.coordinates], area: false }];
    case "Point":
      return [];
  }
}

/**
 * Lists the stations and the charger of a map.
 *
 * @param map - A validated site map.
 * @returns Every point feature, with its kind.
 */
function stationsOf(map: SiteMap): Station[] {
  return map.features.flatMap((feature) => {
    const geometry = feature.geometry;
    return geometry.type === "Point"
      ? [{ kind: feature.properties.kind, point: geometry.coordinates }]
      : [];
  });
}

/**
 * Distance from a point to a straight segment.
 *
 * @param point - The point.
 * @param start - First end of the segment.
 * @param end - Second end of the segment.
 * @returns The distance in metres.
 */
function distanceToSegment(point: Point, start: Point, end: Point): number {
  const [px, py] = point;
  const [ax, ay] = start;
  const [bx, by] = end;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance from a point to a chain of segments, which is the boundary of a ring or a wall.
 *
 * @param point - The point.
 * @param chain - Positions in order; a closed ring repeats its first position last.
 * @returns The smallest distance to any segment of the chain, or infinity for a chain with no segment.
 */
function distanceToChain(point: Point, chain: readonly Point[]): number {
  const [first, ...rest] = chain;
  if (first === undefined) {
    return Infinity;
  }
  let previous: Point = first;
  let best = Infinity;
  for (const current of rest) {
    best = Math.min(best, distanceToSegment(point, previous, current));
    previous = current;
  }
  return best;
}

/**
 * Even-odd test of a point against a closed ring.
 *
 * @param point - The point.
 * @param ring - A closed ring of positions.
 * @returns True when the point lies strictly inside the ring.
 */
function insideRing(point: Point, ring: readonly Point[]): boolean {
  const [px, py] = point;
  const closing = ring.at(-1);
  if (closing === undefined) {
    return false;
  }
  let previous: Point = closing;
  let inside = false;
  for (const current of ring) {
    const [xi, yi] = current;
    const [xj, yj] = previous;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

/**
 * Lists every station that is inside, or closer than the clearance to, a barrier.
 *
 * @param stations - Points to check.
 * @param barriers - Barriers the points must keep clear of.
 * @returns One message per violating pair; empty when every point keeps its clearance.
 */
function violationsOf(stations: readonly Station[], barriers: readonly Barrier[]): string[] {
  const violations: string[] = [];
  for (const { kind, point } of stations) {
    for (const barrier of barriers) {
      const inside = barrier.area && barrier.chains.some((chain) => insideRing(point, chain));
      const tooClose = barrier.chains.some(
        (chain) => distanceToChain(point, chain) <= STATION_CLEARANCE_M,
      );
      if (inside || tooClose) {
        violations.push(
          `${kind} at ${JSON.stringify(point)} is not ${String(STATION_CLEARANCE_M)} m clear of ${barrier.kind}`,
        );
      }
    }
  }
  return violations;
}

/** Text of the committed sample warehouse. */
const SAMPLE_TEXT = readFileSync(`${FIXTURES_DIR}sample-warehouse.geojson`, "utf8");

/**
 * Expected reason of each invalid fixture, as a substring of one of the messages in the error. Zod
 * reports a feature that matches no kind as `Invalid input`, so that message is the expected one there.
 */
const EXPECTED_REASON: ReadonlyMap<string, string> = new Map([
  ["01-two-chargers.geojson", "exactly one charger"],
  ["02-no-charger.geojson", "exactly one charger"],
  ["03-one-workstation.geojson", "at least two workstations"],
  ["04-duplicate-station-name.geojson", "unique"],
  ["05-extent-over-1000-m.geojson", "1 000 m"],
  ["06-unknown-kind.geojson", "Invalid input"],
  ["07-unclosed-ring.geojson", "must be closed"],
  ["08-three-dimensional-position.geojson", "Too big"],
  ["09-non-finite-coordinate.geojson", "received Infinity"],
  ["10-coordinate-out-of-bound.geojson", "1000"],
  ["11-workstation-name-grammar.geojson", "must match pattern"],
  ["12-wrong-crs.geojson", "Invalid input"],
  ["13-workstation-size-zero.geojson", "Too small"],
  ["14-workstation-size-too-large.geojson", "Too big"],
  ["15-workstation-size-extra-key.geojson", "Unrecognized key"],
  ["16-workstation-footprint-over-extent.geojson", "1 000 m"],
  ["17-workstation-size-missing-height.geojson", "expected number"],
]);

/**
 * Collects the messages of a zod error, descending into the branches of a union, so that a reason
 * raised inside one feature is found even though the union reports the feature as a whole.
 *
 * @param issues - The issues of a zod error.
 * @returns Every message, in order.
 */
function messagesOf(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.errors.flatMap((branch) => messagesOf(branch))
      : [issue.message],
  );
}

/**
 * Builds a sample with one extra wall of many positions, so that the total position count can be
 * set exactly. Every position stays inside the coordinate bound and the map extent.
 *
 * @param positions - Number of positions of the extra wall.
 * @returns The map as text.
 */
function mapWithWallOf(positions: number): string {
  const sample = JSON.parse(SAMPLE_TEXT) as { features: unknown[] };
  const coordinates = Array.from({ length: positions }, (_value, index) => [index % 1000, 0]);
  sample.features.push({
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: { kind: "wall" },
  });
  return JSON.stringify(sample);
}

/** Positions of the committed sample: wall 5, three racks of 5, nogo 5, charger 1, four stations. */
const SAMPLE_POSITIONS = 30;

describe("sample warehouse", () => {
  it("parses with the zod schema and with the text parser", () => {
    expect(SiteMapSchema.safeParse(JSON.parse(SAMPLE_TEXT)).success).toBe(true);
    expect(parseSiteMap(SAMPLE_TEXT).features).toHaveLength(10);
  });

  it("declares the local metric frame and version 1", () => {
    expect(parseSiteMap(SAMPLE_TEXT).fleet).toEqual({ crs: "local-metric", version: 1 });
  });

  it("names the four workstations of the design", () => {
    const names = parseSiteMap(SAMPLE_TEXT)
      .features.filter((feature) => feature.properties.kind === "workstation")
      .map((feature) => feature.properties.name);
    expect(names).toEqual(["dock-a", "dock-b", "pack-c", "pack-d"]);
  });
});

describe("workstation footprint", () => {
  it("keeps a map of point-only workstations valid, with no size on any of them (version 1 maps)", () => {
    const map = parseSiteMap(SAMPLE_TEXT);
    const workstations = map.features.filter(
      (feature) => feature.properties.kind === "workstation",
    );
    expect(workstations).toHaveLength(4);
    for (const workstation of workstations) {
      expect(workstation.properties).not.toHaveProperty("size");
    }
  });

  it("keeps the size of a workstation and leaves its point and the other workstations unchanged", () => {
    const map = parseSiteMap(readFileSync(`${FIXTURES_DIR}workstation-with-size.geojson`, "utf8"));
    const workstations = map.features.filter(
      (feature) => feature.properties.kind === "workstation",
    );
    const sized = workstations.find((feature) => feature.properties.name === "dock-a");
    const plain = workstations.find((feature) => feature.properties.name === "dock-b");
    expect(sized?.properties).toEqual({
      kind: "workstation",
      name: "dock-a",
      size: { width: 2, height: 3 },
    });
    expect(sized?.geometry).toEqual({ type: "Point", coordinates: [8, 36] });
    expect(plain?.properties).toEqual({ kind: "workstation", name: "dock-b" });
  });

  it("round-trips a map with sized workstations through JSON without change", () => {
    const map = parseSiteMap(readFileSync(`${FIXTURES_DIR}workstation-with-size.geojson`, "utf8"));
    expect(parseSiteMap(JSON.stringify(map))).toEqual(map);
  });

  it("refuses a size on the charger, which is a point and has no footprint", () => {
    const document = JSON.parse(SAMPLE_TEXT) as {
      features: { properties: Record<string, unknown> }[];
    };
    const charger = document.features.find((feature) => feature.properties.kind === "charger");
    if (charger === undefined) {
      throw new Error("the sample has a charger");
    }
    charger.properties.size = { width: 1, height: 1 };
    expect(SiteMapSchema.safeParse(document).success).toBe(false);
  });

  it("refuses a size on a no-go zone, which is a polygon and has its own shape", () => {
    const document = JSON.parse(SAMPLE_TEXT) as {
      features: { properties: Record<string, unknown> }[];
    };
    const nogo = document.features.find((feature) => feature.properties.kind === "nogo");
    if (nogo === undefined) {
      throw new Error("the sample has a no-go zone");
    }
    nogo.properties.size = { width: 1, height: 1 };
    expect(SiteMapSchema.safeParse(document).success).toBe(false);
  });

  it("refuses a footprint side below the minimum and a non-finite side", () => {
    const document = JSON.parse(SAMPLE_TEXT) as {
      features: { properties: Record<string, unknown> }[];
    };
    const workstation = document.features.find((feature) => feature.properties.name === "dock-a");
    if (workstation === undefined) {
      throw new Error("the sample has dock-a");
    }
    workstation.properties.size = { width: 0.05, height: 2 };
    expect(SiteMapSchema.safeParse(document).success).toBe(false);
    workstation.properties.size = { width: Number.NaN, height: 2 };
    expect(SiteMapSchema.safeParse(document).success).toBe(false);
  });
});

describe("station clearance in the sample warehouse", () => {
  it("keeps every station and the charger outside each barrier expanded by 0.4 m", () => {
    const map = parseSiteMap(SAMPLE_TEXT);
    expect(violationsOf(stationsOf(map), map.features.flatMap(barrierOf))).toEqual([]);
  });

  it("flags a point inside a rack, a point inside the clearance, and accepts a point outside it", () => {
    const rack: Barrier = {
      kind: "obstacle",
      chains: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
      area: true,
    };
    expect(violationsOf([{ kind: "workstation", point: [5, 5] }], [rack])).toHaveLength(1);
    expect(violationsOf([{ kind: "workstation", point: [10.3, 5] }], [rack])).toHaveLength(1);
    expect(violationsOf([{ kind: "workstation", point: [10.5, 5] }], [rack])).toEqual([]);
  });

  it("flags a point inside the clearance of a wall, which is an open chain", () => {
    const wall: Barrier = {
      kind: "wall",
      chains: [
        [
          [0, 0],
          [20, 0],
        ],
      ],
      area: false,
    };
    expect(violationsOf([{ kind: "charger", point: [5, 0.3] }], [wall])).toHaveLength(1);
    expect(violationsOf([{ kind: "charger", point: [5, 0.5] }], [wall])).toEqual([]);
  });
});

describe("invalid fixtures", () => {
  const files = readdirSync(`${FIXTURES_DIR}invalid`).sort();

  it("has one expected reason for every invalid fixture, so none is left unexplained", () => {
    expect(files).toEqual([...EXPECTED_REASON.keys()].sort());
  });

  for (const file of files) {
    it(`refuses ${file} for its stated reason`, () => {
      const text = readFileSync(`${FIXTURES_DIR}invalid/${file}`, "utf8");
      let caught: unknown;
      try {
        parseSiteMap(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(z.ZodError);
      const messages = messagesOf((caught as z.ZodError).issues).join(" | ");
      expect(messages).toContain(EXPECTED_REASON.get(file) ?? "");
    });
  }
});

describe("parseSiteMap bounds", () => {
  it("refuses text larger than 2 MB before parsing it", () => {
    // Multi-byte characters: the character count is under the limit, the byte count is over it.
    const text = "é".repeat(SITE_MAP_MAX_BYTES / 2 + 1);
    expect(text.length).toBeLessThan(SITE_MAP_MAX_BYTES);
    expect(() => parseSiteMap(text)).toThrow(z.ZodError);
    expect(() => parseSiteMap(text)).toThrow("larger than 2 MB");
  });

  it("refuses ASCII text one byte over the bound, which is decided by length alone", () => {
    expect(() => parseSiteMap("a".repeat(SITE_MAP_MAX_BYTES + 1))).toThrow("larger than 2 MB");
  });

  it("passes text at exactly the bound to the parser, which refuses it as not JSON", () => {
    expect(() => parseSiteMap(" ".repeat(SITE_MAP_MAX_BYTES))).toThrow("site map is not JSON");
  });

  it("refuses text that is not JSON with a fixed message that does not echo the input", () => {
    expect(() => parseSiteMap("{ secret token")).toThrow(z.ZodError);
    expect(() => parseSiteMap("{ secret token")).toThrow("site map is not JSON");
  });

  it("refuses a JSON value that is not a feature collection", () => {
    expect(() => parseSiteMap("[]")).toThrow(z.ZodError);
  });

  it("accepts exactly 50 000 positions", () => {
    const text = mapWithWallOf(50_000 - SAMPLE_POSITIONS);
    expect(parseSiteMap(text).features).toHaveLength(11);
  });

  it("refuses 50 001 positions", () => {
    const text = mapWithWallOf(50_000 - SAMPLE_POSITIONS + 1);
    expect(() => parseSiteMap(text)).toThrow("at most 50 000 positions");
  });
});
/* eslint-enable security/detect-non-literal-fs-filename */
