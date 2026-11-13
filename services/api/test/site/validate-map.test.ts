/**
 * Validation of an uploaded map: the happy path, every refusal (each one a `422` with no pinned write), and the
 * idempotency of a repeated or a raced validation.
 */
import { createHash } from "node:crypto";
import { SITE_MAP_MAX_BYTES } from "@mfc/protocol";
import { describe, expect, it, vi } from "vitest";
import { mapObjectKey } from "../../src/domain/site/create-map";
import { validateMap } from "../../src/domain/site/validate-map";
import { createSiteWorld, SITE_START, testCall, TEST_ACTOR } from "./fakes";
import { mapRecordOf, validSiteMap } from "./fixtures";

const KEY = mapObjectKey("paris-01", 1);

/**
 * Stores the upload of version 1 and seeds its pending record.
 *
 * @param body - The bytes the browser uploaded.
 * @param contentType - The media type the object carries.
 * @returns The world, with the object at the version key.
 */
function pendingWith(body: string, contentType?: string) {
  const world = createSiteWorld();
  world.store.seedMap("paris-01", mapRecordOf(1, "PENDING"));
  world.objects.put(KEY, body, contentType);
  return world;
}

/**
 * A map with its features replaced, serialised as the browser would upload it.
 *
 * @param features - The features of the map.
 * @param version - The version the file declares.
 * @returns The JSON text.
 */
function mapText(features: readonly unknown[], version = 1): string {
  return JSON.stringify({ ...validSiteMap(version), features });
}

describe("validateMap, happy path", () => {
  it("pins the object version and its digest, returns VALID and audits the success", async () => {
    const body = JSON.stringify(validSiteMap(1));
    const world = pendingWith(body);
    const versionId = world.objects.objects.get(KEY)?.at(-1)?.versionId;

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        version: 1,
        status: "VALID",
        active: false,
        sizeBytes: Buffer.byteLength(body, "utf8"),
        summary: {
          counts: { wall: 2, obstacle: 1, charger: 1, workstation: 2, nogo: 0 },
          extentM: { x: 20, y: 10 },
        },
      });
    }
    expect(world.store.maps.get("paris-01#1")).toMatchObject({
      status: "VALID",
      s3VersionId: versionId,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
    });
    expect(world.metrics.countOf("SiteMapValidated")).toBe(1);
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "site.map.validate",
        result: "SUCCEEDED",
        mapVersion: 1,
        actor: TEST_ACTOR,
      }),
    ]);
  });

  it("accepts workstations with an optional footprint and pins the same way", async () => {
    const features = validSiteMap(1).features.map((feature) =>
      feature.properties.kind === "workstation" && feature.properties.name === "ws-1"
        ? { ...feature, properties: { ...feature.properties, size: { width: 2, height: 3 } } }
        : feature,
    );
    const world = pendingWith(mapText(features));

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok && result.value).toMatchObject({
      status: "VALID",
      summary: { counts: { workstation: 2 }, extentM: { x: 20, y: 10 } },
    });
  });

  it("never writes the file body into a log entry", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    await validateMap(world.deps, testCall(), "paris-01", 1);
    expect(JSON.stringify(world.logger.entries)).not.toContain("local-metric");
  });
});

describe("validateMap, refusals", () => {
  const schemaDetail = "The uploaded file is not a valid site map.";
  const refusals: [string, () => ReturnType<typeof pendingWith>, string][] = [
    [
      "no object",
      () => {
        const world = createSiteWorld();
        world.store.seedMap("paris-01", mapRecordOf(1, "PENDING"));
        return world;
      },
      "No file was uploaded.",
    ],
    [
      "a file above the size cap",
      () => pendingWith("x".repeat(SITE_MAP_MAX_BYTES + 1)),
      schemaDetail,
    ],
    [
      "a text/plain media type",
      () => pendingWith(JSON.stringify(validSiteMap(1)), "text/plain"),
      schemaDetail,
    ],
    ["text that is not JSON", () => pendingWith("not json at all"), schemaDetail],
    [
      "a map with no charger",
      () =>
        pendingWith(
          mapText(validSiteMap(1).features.filter((f) => f.properties.kind !== "charger")),
        ),
      schemaDetail,
    ],
    [
      "a map with one workstation",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.filter(
              (f) => f.properties.kind !== "workstation" || f.properties.name === "ws-1",
            ),
          ),
        ),
      schemaDetail,
    ],
    [
      "a fleet.version that differs from the version",
      () => pendingWith(mapText(validSiteMap(1).features, 2)),
      schemaDetail,
    ],
    [
      "a feature of an unknown kind",
      () =>
        pendingWith(
          JSON.stringify({
            ...validSiteMap(1),
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [3, 3] },
                properties: { kind: "door" },
              },
            ],
          }),
        ),
      schemaDetail,
    ],
    [
      "a non-finite coordinate",
      () => pendingWith(JSON.stringify(validSiteMap(1)).replace("[1,1]", "[1e999,1]")),
      schemaDetail,
    ],
    [
      "an extent above 1 000 m",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.map((f) =>
              f.properties.kind === "wall" && f.geometry.type === "LineString"
                ? {
                    ...f,
                    geometry: {
                      ...f.geometry,
                      coordinates: [
                        [-500, 0],
                        [501, 0],
                      ],
                    },
                  }
                : f,
            ),
          ),
        ),
      schemaDetail,
    ],
    [
      "more than 5 000 features",
      () => {
        const wall = validSiteMap(1).features[0];
        return pendingWith(mapText(Array.from({ length: 5001 }, () => wall)));
      },
      schemaDetail,
    ],
    [
      "an extra top-level member",
      () => pendingWith(JSON.stringify({ ...validSiteMap(1), extra: true })),
      schemaDetail,
    ],
    [
      "a workstation footprint above 50 m",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.map((f) =>
              f.properties.kind === "workstation" && f.properties.name === "ws-1"
                ? { ...f, properties: { ...f.properties, size: { width: 51, height: 2 } } }
                : f,
            ),
          ),
        ),
      schemaDetail,
    ],
    [
      "a workstation footprint with an extra key",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.map((f) =>
              f.properties.kind === "workstation" && f.properties.name === "ws-1"
                ? {
                    ...f,
                    properties: { ...f.properties, size: { width: 2, height: 2, depth: 1 } },
                  }
                : f,
            ),
          ),
        ),
      schemaDetail,
    ],
    [
      "a workstation footprint that pushes the extent above 1 000 m",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.map((f) =>
              f.properties.kind === "workstation" && f.properties.name === "ws-2"
                ? {
                    ...f,
                    geometry: { type: "Point", coordinates: [500, 5] },
                    properties: { ...f.properties, size: { width: 50, height: 2 } },
                  }
                : f.properties.kind === "wall" && f.geometry.type === "LineString"
                  ? {
                      ...f,
                      geometry: {
                        ...f.geometry,
                        coordinates: [
                          [-500, 0],
                          [500, 0],
                        ],
                      },
                    }
                  : f,
            ),
          ),
        ),
      schemaDetail,
    ],
    [
      "a coordinate of three elements",
      () =>
        pendingWith(
          mapText(
            validSiteMap(1).features.map((f) =>
              f.properties.kind === "wall" && f.geometry.type === "LineString"
                ? {
                    ...f,
                    geometry: {
                      ...f.geometry,
                      coordinates: [
                        [0, 0, 0],
                        [20, 0],
                      ],
                    },
                  }
                : f,
            ),
          ),
        ),
      schemaDetail,
    ],
  ];

  it.each(refusals)(
    "refuses %s with 422 map-invalid and writes nothing",
    async (_, arrange, detail) => {
      const world = arrange();
      const result = await validateMap(world.deps, testCall(), "paris-01", 1);

      expect(result).toMatchObject({
        ok: false,
        problem: { type: "map-invalid", status: 422, detail },
      });
      expect(world.store.calls).not.toContain("markValid");
      expect(world.store.maps.get("paris-01#1")?.status).toBe("PENDING");
      expect(world.metrics.countOf("SiteMapRejected")).toBe(1);
      expect(world.audit.records).toEqual([
        expect.objectContaining({
          action: "site.map.validate",
          result: "REFUSED",
          problemType: "map-invalid",
          mapVersion: 1,
        }),
      ]);
    },
  );

  it("refuses an unknown version with 404 and reads no object", async () => {
    const world = createSiteWorld();
    const result = await validateMap(world.deps, testCall(), "paris-01", 4);
    expect(result).toEqual({
      ok: false,
      problem: {
        type: "map-not-found",
        status: 404,
        detail: "No map version matches this request.",
      },
    });
    expect(world.objects.uploads).toEqual([]);
  });
});

describe("validateMap, schema issues", () => {
  it("returns the issue paths and codes as plain data, and never the value that failed", async () => {
    const world = pendingWith(JSON.stringify({ ...validSiteMap(1), features: "secret-value-123" }));

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.issues?.every((issue) => issue.code.length > 0)).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain("secret-value-123");
  });
});

describe("validateMap, footprint values", () => {
  it("never echoes the footprint value that failed", async () => {
    const features = validSiteMap(1).features.map((feature) =>
      feature.properties.kind === "workstation" && feature.properties.name === "ws-1"
        ? {
            ...feature,
            properties: { ...feature.properties, size: { width: "secret-size-456", height: 2 } },
          }
        : feature,
    );
    const world = pendingWith(mapText(features));

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-size-456");
  });
});

describe("validateMap, pending expiry", () => {
  it("refuses a reservation older than its retention as not found, and reads no object", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    const expired = new Date(SITE_START.getTime() - 24 * 60 * 60 * 1000 - 1).toISOString();
    world.store.seedMap("paris-01", { ...mapRecordOf(1, "PENDING"), createdAt: expired });
    const headSpy = vi.spyOn(world.objects, "head");

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result).toEqual({
      ok: false,
      problem: {
        type: "map-not-found",
        status: 404,
        detail: "No map version matches this request.",
      },
    });
    expect(headSpy).not.toHaveBeenCalled();
    expect(world.store.maps.get("paris-01#1")?.status).toBe("PENDING");
  });

  it("still validates a reservation exactly one day old", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    const oldest = new Date(SITE_START.getTime() - 24 * 60 * 60 * 1000).toISOString();
    world.store.seedMap("paris-01", { ...mapRecordOf(1, "PENDING"), createdAt: oldest });

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok && result.value.status).toBe("VALID");
  });
});

describe("validateMap, idempotency", () => {
  it("returns the version as active when a concurrent request validated and activated it first", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    vi.spyOn(world.store, "markValid").mockImplementationOnce((siteId, version) => {
      world.store.seedMap(siteId, { ...mapRecordOf(version, "VALID") });
      world.store.seedSite(siteId, {
        name: null,
        activeVersion: version,
        nextVersion: version,
        updatedAt: null,
      });
      return Promise.resolve("already");
    });

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok && result.value).toMatchObject({ version: 1, status: "VALID", active: true });
    expect(world.audit.records).toEqual([]);
  });

  it("returns a VALID version as it is, with no object read and no second audit record", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    const first = await validateMap(world.deps, testCall(), "paris-01", 1);
    const headSpy = vi.spyOn(world.objects, "head");

    const second = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(second).toEqual(first);
    expect(headSpy).not.toHaveBeenCalled();
    expect(world.audit.records).toHaveLength(1);
  });

  it("returns the version another request validated when the write finds it already VALID", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    vi.spyOn(world.store, "markValid").mockImplementationOnce((siteId, version) => {
      world.store.seedMap(siteId, { ...mapRecordOf(version, "VALID") });
      return Promise.resolve("already");
    });

    const result = await validateMap(world.deps, testCall(), "paris-01", 1);

    expect(result.ok && result.value.status).toBe("VALID");
    expect(world.audit.records).toEqual([]);
  });

  it("still succeeds and counts the failure when the audit write fails", async () => {
    const world = pendingWith(JSON.stringify(validSiteMap(1)));
    world.audit.gate.fail("write", new Error("ThrottlingException"));
    const result = await validateMap(world.deps, testCall(), "paris-01", 1);
    expect(result.ok).toBe(true);
    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
  });
});
