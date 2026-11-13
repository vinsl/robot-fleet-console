/**
 * Site configuration contract: name and reference grammars, strict response objects, the presigned
 * transfer responses, and the summary of a map.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- the fixture path is a fixed path of this test; no input reaches the read */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CreateMapResponseSchema,
  MapRefParamSchema,
  MapUrlResponseSchema,
  MapVersionSchema,
  MapVersionsResponseSchema,
  ProblemSchema,
  PROBLEM_TYPES,
  SITE_MAP_MAX_BYTES,
  SiteMapNameSchema,
  SiteNameSchema,
  SiteSchema,
  UpdateSiteRequestSchema,
  isSiteMapS3Url,
  parseSiteMap,
  summarizeSiteMap,
  type SiteMap,
} from "../src/index";

/** Committed sample map, parsed by the same schema the planner uses. */
const SAMPLE_PATH = fileURLToPath(
  new URL("./fixtures/site-map/sample-warehouse.geojson", import.meta.url),
);

/** A valid upload slot, copied per test so that one test cannot change another. */
const UPLOAD = {
  version: 1,
  upload: {
    url: "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/",
    fields: { key: "sites/paris-01/maps/000001.geojson", "Content-Type": "application/geo+json" },
    expiresAt: "2026-11-03T10:05:00.000Z",
  },
  maxBytes: 2_000_000,
};

/** A small map: one charger, two workstations, one wall, one obstacle; extent 15 m by 13 m. */
const SMALL_MAP: unknown = {
  type: "FeatureCollection",
  fleet: { crs: "local-metric", version: 1 },
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { kind: "charger" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { kind: "workstation", name: "ws-1" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [5, -1] },
      properties: { kind: "workstation", name: "ws-2" },
    },
    {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [-3, 0],
          [4, 0],
        ],
      },
      properties: { kind: "wall" },
    },
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10, 10],
            [12, 10],
            [12, 12],
            [10, 12],
            [10, 10],
          ],
        ],
      },
      properties: { kind: "obstacle" },
    },
  ],
};

describe("MapRefParamSchema", () => {
  it.each(["active", "1", "7", "999999"])("accepts %j", (ref) => {
    expect(MapRefParamSchema.safeParse(ref).success).toBe(true);
  });

  it.each(["0", "07", "1e3", "-1", "active ", "7/../", "", "1000000", "Active", "1.5"])(
    "refuses %j",
    (ref) => {
      expect(MapRefParamSchema.safeParse(ref).success).toBe(false);
    },
  );

  it("converts an accepted version segment to its number", () => {
    expect(MapRefParamSchema.parse("42")).toBe(42);
  });
});

describe("SiteNameSchema", () => {
  it("trims the name and keeps its visible characters", () => {
    expect(SiteNameSchema.parse("  Depot A  ")).toBe("Depot A");
  });

  it("accepts a name of exactly 64 characters", () => {
    expect(SiteNameSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it.each([
    ["markup", "<script>alert(1)</script>"],
    ["an angle bracket", "a>b"],
    ["a line feed", "a\nb"],
    ["a NUL", "a\u0000b"],
    ["a DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
  ])("refuses a name with %s", (_label, name) => {
    expect(SiteNameSchema.safeParse(name).success).toBe(false);
  });

  it("refuses a name of 65 characters", () => {
    expect(SiteNameSchema.safeParse("a".repeat(65)).success).toBe(false);
  });

  it("refuses a name that is empty once trimmed", () => {
    expect(SiteNameSchema.safeParse("   ").success).toBe(false);
  });

  it.each([
    // Built from a code point so that no bidi character sits in the source, as the lint rule requires.
    ["a bidirectional override (U+202E)", `Depot${String.fromCodePoint(0x202e)}abc`],
    ["a line separator (U+2028) inside the name", "Depot A"],
    ["a paragraph separator (U+2029) inside the name", "Depot A"],
    ["a zero-width format character (U+200B)", "Depot​A"],
  ])("refuses a name with %s", (_label, name) => {
    expect(SiteNameSchema.safeParse(name).success).toBe(false);
  });

  it("measures the length after trimming, so padding does not count", () => {
    expect(SiteNameSchema.parse(`  ${"a".repeat(64)}  `)).toBe("a".repeat(64));
  });

  it("refuses a 65-character name even when padding would bring it to 64 untrimmed", () => {
    expect(SiteNameSchema.safeParse(`${"a".repeat(65)}  `).success).toBe(false);
  });
});

describe("SiteMapNameSchema", () => {
  it("accepts the slug grammar of the map", () => {
    expect(SiteMapNameSchema.safeParse("ws-1").success).toBe(true);
  });

  it("refuses an upper-case or spaced name", () => {
    expect(SiteMapNameSchema.safeParse("Ws 1").success).toBe(false);
  });
});

describe("site responses are strict", () => {
  it("accepts a site profile with an active version and an update time", () => {
    expect(
      SiteSchema.safeParse({
        siteId: "paris-01",
        name: "Demo",
        activeVersion: 3,
        updatedAt: "2026-11-03T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("refuses a site profile with an extra field", () => {
    expect(
      SiteSchema.safeParse({
        siteId: "paris-01",
        name: "Demo",
        activeVersion: null,
        updatedAt: null,
        ownerEmail: "someone@example.com",
      }).success,
    ).toBe(false);
  });

  it.each([0, 1_000_000])("refuses an active version of %j", (activeVersion) => {
    expect(
      SiteSchema.safeParse({
        siteId: "paris-01",
        name: "Demo",
        activeVersion,
        updatedAt: null,
      }).success,
    ).toBe(false);
  });

  it("refuses an update request that tries to set the site identifier", () => {
    expect(UpdateSiteRequestSchema.safeParse({ name: "Demo", siteId: "other-site" }).success).toBe(
      false,
    );
  });

  it("refuses an update request whose name carries markup", () => {
    expect(UpdateSiteRequestSchema.safeParse({ name: "<img onerror=x>" }).success).toBe(false);
  });

  it("refuses a version list longer than the version limit", () => {
    const version = {
      version: 1,
      status: "PENDING",
      createdAt: "2026-11-03T10:00:00.000Z",
      createdBy: "vincent",
      sizeBytes: null,
      summary: null,
      active: false,
    };
    const versions = Array.from({ length: 201 }, () => version);
    expect(MapVersionsResponseSchema.safeParse({ versions }).success).toBe(false);
  });
});

describe("CreateMapResponseSchema", () => {
  it("accepts a presigned upload slot", () => {
    expect(CreateMapResponseSchema.safeParse(UPLOAD).success).toBe(true);
  });

  it("refuses a plain http upload URL", () => {
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, url: "http://example.com/upload" } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses more than twenty form fields", () => {
    const fields = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${String(i)}`, "v"]));
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses an extra field at the top level", () => {
    expect(CreateMapResponseSchema.safeParse({ ...UPLOAD, key: "x" }).success).toBe(false);
  });

  it("refuses a field name longer than 64 characters", () => {
    const fields = { ...UPLOAD.upload.fields, [`k${"a".repeat(64)}`]: "v" };
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses the field name %s", (name) => {
    // Object.fromEntries defines an own property, so the name reaches the schema as a key of its own.
    const fields = Object.fromEntries([...Object.entries(UPLOAD.upload.fields), [name, "v"]]);
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it.each(["a b", "a/b", "a=b", "é"])(
    "refuses the field name %j outside the form grammar",
    (name) => {
      const fields = { ...UPLOAD.upload.fields, [name]: "v" };
      const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
      expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
    },
  );

  it.each(["key", "Content-Type"])("refuses a form without the %s field", (required) => {
    const fields = Object.fromEntries(
      Object.entries(UPLOAD.upload.fields).filter(([name]) => name !== required),
    );
    expect(Object.keys(fields)).not.toContain(required);
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses a field value longer than 8192 characters", () => {
    const fields = { ...UPLOAD.upload.fields, policy: "p".repeat(8193) };
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, fields } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    [
      "an https URL with user credentials",
      "https://user:pass@mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/",
    ],
    ["a user name alone", "https://x@mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/"],
    ["a foreign host", "https://evil.example.com/"],
    ["a look-alike host", "https://mfc.s3.eu-west-3.amazonaws.com.evil.example.com/"],
    ["an explicit default port", "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com:443/"],
    ["a non-default port", "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com:8443/"],
    ["a fragment", "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/#frag"],
  ])("refuses an upload URL with %s", (_label, url) => {
    const body = { ...UPLOAD, upload: { ...UPLOAD.upload, url } };
    expect(CreateMapResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses a maxBytes above the site map limit", () => {
    expect(
      CreateMapResponseSchema.safeParse({ ...UPLOAD, maxBytes: SITE_MAP_MAX_BYTES + 1 }).success,
    ).toBe(false);
  });
});

describe("MapUrlResponseSchema", () => {
  const DOWNLOAD = {
    version: 1,
    url: "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/sites/paris-01/maps/000001.geojson?X-Amz-Signature=abc",
    expiresAt: "2026-11-03T10:05:00.000Z",
    sizeBytes: 10,
  };

  it("accepts a presigned download of a validated version", () => {
    expect(MapUrlResponseSchema.safeParse(DOWNLOAD).success).toBe(true);
  });

  it("refuses a download URL that is not HTTPS", () => {
    expect(
      MapUrlResponseSchema.safeParse({
        version: 1,
        url: "ftp://example.com/map",
        expiresAt: "2026-11-03T10:05:00.000Z",
        sizeBytes: 10,
      }).success,
    ).toBe(false);
  });

  it("refuses a download URL on a host that is not an S3 host", () => {
    expect(
      MapUrlResponseSchema.safeParse({ ...DOWNLOAD, url: "https://evil.example.com/map" }).success,
    ).toBe(false);
  });

  it("refuses a size above the site map limit", () => {
    expect(
      MapUrlResponseSchema.safeParse({ ...DOWNLOAD, sizeBytes: SITE_MAP_MAX_BYTES + 1 }).success,
    ).toBe(false);
  });
});

describe("MapVersionSchema", () => {
  const VERSION = {
    version: 1,
    status: "VALID",
    createdAt: "2026-11-03T10:00:00.000Z",
    createdBy: "vincent",
    sizeBytes: 1024,
    summary: null,
    active: false,
  };

  it("accepts a validated version with its size", () => {
    expect(MapVersionSchema.safeParse(VERSION).success).toBe(true);
  });

  it("refuses a size above the site map limit", () => {
    expect(
      MapVersionSchema.safeParse({ ...VERSION, sizeBytes: SITE_MAP_MAX_BYTES + 1 }).success,
    ).toBe(false);
  });
});

describe("isSiteMapS3Url", () => {
  it.each([
    "https://mfc-demo-site-maps-abc.s3.eu-west-3.amazonaws.com/",
    "https://bucket-1.s3.us-east-1.amazonaws.com/key?X-Amz-Signature=abc",
  ])("accepts %j", (url) => {
    expect(isSiteMapS3Url(url)).toBe(true);
  });

  it.each([
    "https://x@evil.example.com/",
    "https://user:pass@bucket.s3.eu-west-3.amazonaws.com/",
    "https://bucket.s3.eu-west-3.amazonaws.com:443/",
    "https://evil.example.com/",
    "https://bucket.s3.eu-west-3.amazonaws.com.evil.example.com/",
    "https://BUCKET.s3.eu-west-3.amazonaws.com/",
    "https://bucket.s3.eu-west-3.amazonaws.com/#frag",
    "http://bucket.s3.eu-west-3.amazonaws.com/",
    "not a url",
  ])("refuses %j", (url) => {
    expect(isSiteMapS3Url(url)).toBe(false);
  });
});

describe("PROBLEM_TYPES for the site API", () => {
  it.each([
    ["map-not-found", 404],
    ["map-invalid", 422],
    ["version-limit", 409],
  ])("publishes %s as a problem that carries its status", (type, status) => {
    expect(PROBLEM_TYPES).toContain(type);
    const problem = ProblemSchema.safeParse({
      type: `urn:mfc:problem:${type}`,
      title: "Site problem",
      status,
      correlationId: "corr-0003-abcd",
    });
    expect(problem.success).toBe(true);
    expect(problem.data?.status).toBe(status);
  });
});

describe("summarizeSiteMap", () => {
  it("counts each feature kind and measures the extent of the positions", () => {
    const map: SiteMap = parseSiteMap(JSON.stringify(SMALL_MAP));
    expect(summarizeSiteMap(map)).toEqual({
      counts: { wall: 1, obstacle: 1, charger: 1, workstation: 2, nogo: 0 },
      extentM: { x: 15, y: 13 },
    });
  });

  it("reports a zero extent for a map without positions", () => {
    const empty: SiteMap = {
      type: "FeatureCollection",
      fleet: { crs: "local-metric", version: 1 },
      features: [],
    };
    expect(summarizeSiteMap(empty).extentM).toEqual({ x: 0, y: 0 });
  });

  it("summarises the committed sample map into a schema-valid version", () => {
    const text = readFileSync(SAMPLE_PATH, "utf8");
    const map = parseSiteMap(text);
    const summary = summarizeSiteMap(map);
    const counts = summary.counts;
    expect(counts.charger + counts.workstation + counts.wall + counts.obstacle + counts.nogo).toBe(
      map.features.length,
    );

    const version = MapVersionSchema.parse({
      version: 1,
      status: "VALID",
      createdAt: "2026-11-03T10:00:00.000Z",
      createdBy: "vincent",
      sizeBytes: text.length,
      summary,
      active: true,
    });
    expect(version.summary).toEqual(summary);
  });
});

describe("PROBLEM_TYPES for the site API", () => {
  it.each(["map-not-found", "map-invalid", "version-limit"])("publishes %s", (type) => {
    expect(PROBLEM_TYPES).toContain(type);
  });
});
