/**
 * Map version use cases: the reservation of an upload slot, the version list, and the presigned download.
 */
import { describe, expect, it, vi } from "vitest";
import { createMap, mapObjectKey } from "../../src/domain/site/create-map";
import { getMapUrl } from "../../src/domain/site/get-map-url";
import { listMaps } from "../../src/domain/site/list-maps";
import { MAP_MAX_VERSIONS, SITE_MAP_MAX_BYTES } from "@mfc/protocol";
import { createSiteWorld, testCall, TEST_ACTOR, SITE_START } from "./fakes";
import { mapRecordOf } from "./fixtures";

describe("createMap", () => {
  it("allocates version 1, reserves it PENDING and presigns its upload", async () => {
    const world = createSiteWorld();
    const result = await createMap(world.deps, testCall(), "paris-01");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.version).toBe(1);
    expect(result.value.maxBytes).toBe(SITE_MAP_MAX_BYTES);
    expect(world.objects.uploads).toEqual(["sites/paris-01/maps/000001.geojson"]);

    const stored = world.store.maps.get("paris-01#1");
    expect(stored).toMatchObject({
      version: 1,
      status: "PENDING",
      createdBy: TEST_ACTOR,
      s3Key: "sites/paris-01/maps/000001.geojson",
      createdAt: SITE_START.toISOString(),
    });
    const expiry = world.store.expiries.get("paris-01#1");
    expect(expiry).toBe(Math.floor(SITE_START.getTime() / 1000) + 24 * 60 * 60);
  });

  it("audits the slot with its version and succeeds with the upload fields", async () => {
    const world = createSiteWorld();
    const result = await createMap(world.deps, testCall(), "paris-01");
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "site.map.create",
        result: "SUCCEEDED",
        mapVersion: 1,
        actorSource: "mfc.jwt",
      }),
    ]);
    expect(result.ok && result.value.upload.fields).toMatchObject({
      "Content-Type": "application/geo+json",
    });
  });

  it("refuses with 409 version-limit and presigns nothing when the cap is reached", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: null,
      activeVersion: null,
      nextVersion: MAP_MAX_VERSIONS,
      updatedAt: null,
    });
    const result = await createMap(world.deps, testCall(), "paris-01");
    expect(result).toEqual({
      ok: false,
      problem: {
        type: "version-limit",
        status: 409,
        detail: "The site has reached its map version limit.",
      },
    });
    expect(world.objects.uploads).toEqual([]);
    expect(world.store.maps.size).toBe(0);
    expect(world.audit.records).toEqual([]);
  });

  it("does not burn a number when the reservation fails, so the next upload is version 1", async () => {
    const world = createSiteWorld();
    vi.spyOn(world.store, "reserveMap").mockRejectedValueOnce(new Error("ThrottlingException"));

    await expect(createMap(world.deps, testCall(), "paris-01")).rejects.toThrow(
      "ThrottlingException",
    );
    const next = await createMap(world.deps, testCall(), "paris-01");

    expect(next.ok && next.value.version).toBe(1);
  });

  it("never writes the presigned URL or the fields into a log entry", async () => {
    const world = createSiteWorld();
    await createMap(world.deps, testCall(), "paris-01");
    const logs = JSON.stringify(world.logger.entries);
    expect(logs).not.toContain("https://");
    expect(logs).not.toContain("fake-signature");
    expect(logs).not.toContain("fake-policy");
  });
});

describe("mapObjectKey", () => {
  it("pads the version to six digits so keys sort in version order", () => {
    expect(mapObjectKey("paris-01", 1)).toBe("sites/paris-01/maps/000001.geojson");
    expect(mapObjectKey("paris-01", 199)).toBe("sites/paris-01/maps/000199.geojson");
  });
});

describe("listMaps", () => {
  it("lists the versions newest first and marks the active one", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: "Hall A",
      activeVersion: 2,
      nextVersion: 3,
      updatedAt: null,
    });
    world.store.seedMap("paris-01", mapRecordOf(1, "VALID"));
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));
    world.store.seedMap("paris-01", mapRecordOf(3, "PENDING"));

    const result = await listMaps(world.deps, "paris-01");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(result.value.versions.map((version) => version.active)).toEqual([false, true, false]);
    expect(result.value.versions[0]).toEqual({
      version: 3,
      status: "PENDING",
      createdAt: "2026-11-02T09:00:00.000Z",
      createdBy: TEST_ACTOR,
      sizeBytes: null,
      summary: null,
      active: false,
    });
  });

  it("lists nothing for a site with no versions", async () => {
    const world = createSiteWorld();
    const result = await listMaps(world.deps, "paris-01");
    expect(result).toEqual({ ok: true, value: { versions: [] } });
  });
});

describe("getMapUrl", () => {
  it("presigns the download of a VALID version with its pinned object version", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));

    const result = await getMapUrl(world.deps, "paris-01", 2);
    expect(result.ok).toBe(true);
    expect(world.objects.downloads).toEqual([
      {
        key: "sites/paris-01/maps/000002.geojson",
        versionId: "pinned-2",
        version: 2,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        version: 2,
        url: `https://mfc-demo-site-maps-test.s3.eu-west-3.amazonaws.com/sites/paris-01/maps/000002.geojson?versionId=pinned-2&X-Amz-Signature=fake`,
        expiresAt: new Date(SITE_START.getTime() + 300_000).toISOString(),
        sizeBytes: 1234,
      },
    });
  });

  it("resolves active to the site's active version", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: null,
      activeVersion: 2,
      nextVersion: 2,
      updatedAt: null,
    });
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));
    const result = await getMapUrl(world.deps, "paris-01", "active");
    expect(result.ok && result.value.version).toBe(2);
  });

  it("refuses active with 404 when the site has no active map and presigns nothing", async () => {
    const world = createSiteWorld();
    const result = await getMapUrl(world.deps, "paris-01", "active");
    expect(result).toEqual({
      ok: false,
      problem: { type: "map-not-found", status: 404, detail: "The site has no active map." },
    });
    expect(world.objects.downloads).toEqual([]);
  });

  it("refuses a PENDING version with 404 and presigns nothing", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(1, "PENDING"));
    const result = await getMapUrl(world.deps, "paris-01", 1);
    expect(result).toEqual({
      ok: false,
      problem: {
        type: "map-not-found",
        status: 404,
        detail: "No map version matches this request.",
      },
    });
    expect(world.objects.downloads).toEqual([]);
  });

  it("refuses an unknown version with 404", async () => {
    const world = createSiteWorld();
    const result = await getMapUrl(world.deps, "paris-01", 9);
    expect(result.ok).toBe(false);
  });

  it("never writes the presigned URL into a log entry", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));
    await getMapUrl(world.deps, "paris-01", 2);
    expect(JSON.stringify(world.logger.entries)).not.toContain("X-Amz-Signature");
  });
});
