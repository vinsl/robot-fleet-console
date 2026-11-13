/**
 * Activation of a map version: the validated version becomes the active map; a version that is not validated, an
 * unknown version and a version already active are each handled without the wrong write.
 */
import { describe, expect, it, vi } from "vitest";
import { activateMap } from "../../src/domain/site/activate-map";
import { createSiteWorld, testCall, TEST_ACTOR } from "./fakes";
import { mapRecordOf } from "./fixtures";

describe("activateMap", () => {
  it("activates a VALID version, audits it and returns the site naming it", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));

    const result = await activateMap(world.deps, testCall(), "paris-01", 2);

    expect(result).toEqual({
      ok: true,
      value: {
        siteId: "paris-01",
        name: "paris-01",
        activeVersion: 2,
        updatedAt: "2026-11-02T10:00:00.000Z",
      },
    });
    expect(world.metrics.countOf("SiteMapActivated")).toBe(1);
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "site.map.activate",
        result: "SUCCEEDED",
        mapVersion: 2,
        actor: TEST_ACTOR,
      }),
    ]);
  });

  it("returns the site unchanged, with no write and no audit, when the version is already active", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: "Hall A",
      activeVersion: 2,
      nextVersion: 2,
      updatedAt: "2026-11-01T08:00:00.000Z",
    });
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));

    const result = await activateMap(world.deps, testCall(), "paris-01", 2);

    expect(result).toEqual({
      ok: true,
      value: {
        siteId: "paris-01",
        name: "Hall A",
        activeVersion: 2,
        updatedAt: "2026-11-01T08:00:00.000Z",
      },
    });
    expect(world.store.calls).not.toContain("activate");
    expect(world.audit.records).toEqual([]);
  });

  it("refuses a PENDING version with 422 and does not activate it", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(3, "PENDING"));

    const result = await activateMap(world.deps, testCall(), "paris-01", 3);

    expect(result).toEqual({
      ok: false,
      problem: { type: "map-invalid", status: 422, detail: "Validate the map first." },
    });
    expect(world.store.calls).not.toContain("activate");
    expect(world.audit.records).toEqual([]);
  });

  it("refuses an unknown version with 404", async () => {
    const world = createSiteWorld();
    const result = await activateMap(world.deps, testCall(), "paris-01", 9);
    expect(result).toEqual({
      ok: false,
      problem: {
        type: "map-not-found",
        status: 404,
        detail: "No map version matches this request.",
      },
    });
  });

  it("refuses with 422 when the transaction finds the version no longer VALID", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));
    vi.spyOn(world.store, "activate").mockResolvedValueOnce("not-valid");

    const result = await activateMap(world.deps, testCall(), "paris-01", 2);

    expect(result).toEqual({
      ok: false,
      problem: { type: "map-invalid", status: 422, detail: "Validate the map first." },
    });
    expect(world.audit.records).toEqual([]);
  });

  it("still succeeds and counts the failure when the audit write fails", async () => {
    const world = createSiteWorld();
    world.store.seedMap("paris-01", mapRecordOf(2, "VALID"));
    world.audit.gate.fail("write", new Error("ThrottlingException"));
    const result = await activateMap(world.deps, testCall(), "paris-01", 2);
    expect(result.ok).toBe(true);
    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
  });
});
