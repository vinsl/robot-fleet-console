/**
 * Site profile use cases: the default profile of a site with no item, and the name update.
 */
import { describe, expect, it } from "vitest";
import { getSite } from "../../src/domain/site/get-site";
import { updateSite } from "../../src/domain/site/update-site";
import { createSiteWorld, testCall, TEST_ACTOR, SITE_START } from "./fakes";

describe("getSite", () => {
  it("returns the default profile and writes nothing when the site has no item", async () => {
    const world = createSiteWorld();
    const result = await getSite(world.deps, "paris-01");
    expect(result).toEqual({
      ok: true,
      value: { siteId: "paris-01", name: "paris-01", activeVersion: null, updatedAt: null },
    });
    expect(world.store.calls).toEqual(["getSite"]);
    expect(world.store.sites.size).toBe(0);
  });

  it("returns the stored name and active version", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: "Hall A",
      activeVersion: 2,
      nextVersion: 2,
      updatedAt: "2026-11-01T08:00:00.000Z",
    });
    const result = await getSite(world.deps, "paris-01");
    expect(result).toEqual({
      ok: true,
      value: {
        siteId: "paris-01",
        name: "Hall A",
        activeVersion: 2,
        updatedAt: "2026-11-01T08:00:00.000Z",
      },
    });
  });
});

describe("updateSite", () => {
  it("stores the name, audits the change and returns the stored profile", async () => {
    const world = createSiteWorld();
    const result = await updateSite(world.deps, testCall(), "paris-01", { name: "Hall B" });

    expect(result).toEqual({
      ok: true,
      value: {
        siteId: "paris-01",
        name: "Hall B",
        activeVersion: null,
        updatedAt: SITE_START.toISOString(),
      },
    });
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "site.update",
      result: "SUCCEEDED",
      actor: TEST_ACTOR,
      actorSource: "mfc.jwt",
      siteId: "paris-01",
      correlationId: "corr-00000001",
    });
    expect(world.audit.records[0]).not.toHaveProperty("robotId");
  });

  it("keeps the active version and the allocated counter of the stored profile", async () => {
    const world = createSiteWorld();
    world.store.seedSite("paris-01", {
      name: "Hall A",
      activeVersion: 4,
      nextVersion: 5,
      updatedAt: null,
    });
    await updateSite(world.deps, testCall(), "paris-01", { name: "Hall B" });
    expect(world.store.sites.get("paris-01")).toEqual({
      name: "Hall B",
      activeVersion: 4,
      nextVersion: 5,
      updatedAt: SITE_START.toISOString(),
    });
  });

  it("still succeeds and counts the failure when the audit write fails", async () => {
    const world = createSiteWorld();
    world.audit.gate.fail("write", new Error("ThrottlingException"));
    const result = await updateSite(world.deps, testCall(), "paris-01", { name: "Hall B" });
    expect(result.ok).toBe(true);
    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
    expect(world.logger.entries.some((entry) => entry.message === "audit write failed")).toBe(true);
  });
});
