/**
 * Use cases of the demo mode: the flag reads disabled by default, an Admin switches it, every switch is audited.
 */
import { describe, expect, it } from "vitest";
import { getDemo, setDemo } from "../../../src/domain/control/demo";
import { ADMIN, CONTROL_SITE, controlWorld } from "../../fakes/control";

describe("demo mode", () => {
  it("demo-get-any-role", async () => {
    const world = controlWorld();
    expect(await getDemo(world.deps, CONTROL_SITE)).toEqual({
      ok: true,
      value: { enabled: false },
    });

    world.demo.state = {
      enabled: true,
      changedBy: ADMIN.userId,
      changedAt: "2026-11-04T10:00:00.000Z",
    };
    expect(await getDemo(world.deps, CONTROL_SITE)).toEqual({ ok: true, value: world.demo.state });
  });

  it("demo-set-admin", async () => {
    const world = controlWorld();
    const result = await setDemo(
      world.deps,
      ADMIN,
      CONTROL_SITE,
      { enabled: true },
      world.callWith(),
    );

    expect(result).toEqual({
      ok: true,
      value: { enabled: true, changedBy: ADMIN.userId, changedAt: "2026-11-04T10:00:00.000Z" },
    });
    expect(world.demo.state.enabled).toBe(true);
  });

  it("demo-set-audited", async () => {
    const world = controlWorld();
    await setDemo(world.deps, ADMIN, CONTROL_SITE, { enabled: true }, world.callWith());
    await setDemo(world.deps, ADMIN, CONTROL_SITE, { enabled: false }, world.callWith());

    expect(world.audit.records.map((record) => record.action)).toEqual([
      "demo.enable",
      "demo.disable",
    ]);
    expect(world.audit.records[0]).toMatchObject({
      result: "SUCCEEDED",
      actor: ADMIN.userId,
      actorSource: "mfc.jwt",
    });
    expect(world.audit.records[0]).not.toHaveProperty("robotId");
    expect(world.metrics.value("DemoToggled")).toBe(2);
  });

  it("a failed audit write does not fail the switch", async () => {
    const world = controlWorld();
    world.audit.failure = new Error("throttled");
    const result = await setDemo(
      world.deps,
      ADMIN,
      CONTROL_SITE,
      { enabled: true },
      world.callWith(),
    );

    expect(result.ok).toBe(true);
    expect(world.metrics.value("AuditWriteFailed")).toBe(1);
  });
});
