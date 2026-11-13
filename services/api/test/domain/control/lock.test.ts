/**
 * Use cases of the robot lock: take, release, read, and the shape of the token.
 */
import { LockRequestSchema, LockStateSchema, commandTopic } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  getLock,
  lockStateOf,
  newLockToken,
  releaseLock,
  type LockTarget,
} from "../../../src/domain/control/lock";
import type { Principal } from "../../../src/domain/authz";
import {
  ADMIN,
  CONTROL_ROBOT,
  CONTROL_SITE,
  CONTROL_START_SECONDS,
  FIXTURE_TOKEN,
  OPERATOR,
  OPERATOR_SUB,
  OTHER_OPERATOR_SUB,
  commandIdOf,
  controlWorld,
  liveLockOf,
  sentCommandOf,
  type ControlWorld,
} from "../../fakes/control";

const TARGET: LockTarget = { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT };

/**
 * Takes control of the fixture robot.
 *
 * @param world - The control world.
 * @param principal - The caller.
 * @param n - Number of the client identifier.
 * @returns The use case outcome.
 */
function take(world: ControlWorld, principal: Principal, n: number) {
  return acquireLock(
    world.deps,
    principal,
    TARGET,
    LockRequestSchema.parse({ commandId: commandIdOf(n) }),
    world.callWith(),
  );
}

/**
 * Releases control of the fixture robot.
 *
 * @param world - The control world.
 * @param principal - The caller.
 * @param n - Number of the client identifier.
 * @returns The use case outcome.
 */
function release(world: ControlWorld, principal: Principal, n: number) {
  return releaseLock(
    world.deps,
    principal,
    TARGET,
    LockRequestSchema.parse({ commandId: commandIdOf(n) }),
    world.callWith(),
  );
}

describe("robot lock", () => {
  it("acquire-free", async () => {
    const world = controlWorld();
    const result = await take(world, OPERATOR, 1);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        changed: true,
        lock: { held: true, mine: true, holder: OPERATOR_SUB },
      });
    }
    const command = sentCommandOf(world);
    expect(command.type).toBe("TAKE_CONTROL");
    expect(command.commandId).toBe(commandIdOf(1));
    expect(command.lockToken).toHaveLength(43);
    expect(world.publisher.published[0]?.topic).toBe(commandTopic(CONTROL_SITE, CONTROL_ROBOT));
    expect(world.relay.changes).toEqual([
      {
        siteId: CONTROL_SITE,
        robotId: CONTROL_ROBOT,
        held: true,
        holder: OPERATOR_SUB,
        cause: "ACQUIRED",
      },
    ]);
    expect(world.audit.records[0]).toMatchObject({
      action: "lock.acquire",
      result: "SUCCEEDED",
      robotId: CONTROL_ROBOT,
    });
  });

  it("acquire-keeps-own-token", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const result = await take(world, OPERATOR, 2);

    expect(result.ok && result.value.changed).toBe(false);
    expect(world.locks.items.get(CONTROL_ROBOT)?.token).toBe(FIXTURE_TOKEN);
    expect(sentCommandOf(world).lockToken).toBe(FIXTURE_TOKEN);
  });

  it("acquire-other-live-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OTHER_OPERATOR_SUB));
    const result = await take(world, OPERATOR, 3);

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.audit.records[0]).toMatchObject({
      action: "lock.acquire",
      result: "REFUSED",
      problemType: "lock-held",
    });
    expect(world.metrics.value("LockRefused")).toBe(1);
  });

  it("acquire-after-expiry-takeover-cause", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OTHER_OPERATOR_SUB, -10));
    const result = await take(world, OPERATOR, 4);

    expect(result.ok).toBe(true);
    expect(world.relay.changes[0]).toMatchObject({
      held: true,
      holder: OPERATOR_SUB,
      cause: "TAKEOVER",
    });
    expect(world.locks.items.get(CONTROL_ROBOT)?.holder).toBe(OPERATOR_SUB);
  });

  it("acquire-race-held-409", async () => {
    const world = controlWorld();
    world.locks.loseNextAcquire();
    const result = await take(world, OPERATOR, 5);

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.claims.claims.size).toBe(0);
  });

  it("acquire-publish-failure-releases-item", async () => {
    const world = controlWorld();
    world.publisher.failure = new Error("broker down");
    const result = await take(world, OPERATOR, 6);

    expect(result).toMatchObject({ ok: false, problem: { type: "upstream-failed", status: 502 } });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(false);
    expect(world.claims.claims.size).toBe(0);
    expect(world.relay.changes).toEqual([]);
    expect(world.audit.records[0]).toMatchObject({ action: "lock.acquire", result: "FAILED" });
  });

  it("acquire-publish-failure-keeps-own-refreshed-lock", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.publisher.failure = new Error("broker down");
    await take(world, OPERATOR, 7);

    expect(world.locks.items.get(CONTROL_ROBOT)?.holder).toBe(OPERATOR_SUB);
  });

  it("acquire-replay-after-release-changes-nothing", async () => {
    const world = controlWorld();
    await take(world, OPERATOR, 8);
    await release(world, OPERATOR, 9);
    const replay = await take(world, OPERATOR, 8);

    expect(replay.ok && replay.value).toMatchObject({ changed: false, lock: { held: false } });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(false);
    expect(world.publisher.published).toHaveLength(2);
  });

  it("lock-response-has-no-token", async () => {
    const world = controlWorld();
    const taken = await take(world, OPERATOR, 10);
    const state = await getLock(world.deps, OPERATOR, TARGET);
    const everything = JSON.stringify([
      taken,
      state,
      world.audit.records,
      world.relay.changes,
      world.logger.entries,
    ]);

    expect(everything).not.toContain(FIXTURE_TOKEN);
    expect(LockStateSchema.safeParse(state.ok ? state.value : null).success).toBe(true);
  });

  it("release-mine", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const result = await release(world, OPERATOR, 11);

    expect(result).toMatchObject({
      ok: true,
      value: { changed: true, lock: { held: false, mine: false } },
    });
    expect(sentCommandOf(world).type).toBe("RELEASE_CONTROL");
    expect(sentCommandOf(world).lockToken).toBe(FIXTURE_TOKEN);
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(false);
    expect(world.relay.changes[0]).toMatchObject({ held: false, cause: "RELEASED" });
    expect(world.audit.records[0]).toMatchObject({ action: "lock.release", result: "SUCCEEDED" });
  });

  it("release-none-changed-false", async () => {
    const world = controlWorld();
    const result = await release(world, OPERATOR, 12);

    expect(result).toMatchObject({ ok: true, value: { changed: false, lock: { held: false } } });
    expect(world.publisher.published).toEqual([]);
  });

  it("release-other-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OTHER_OPERATOR_SUB));
    const result = await release(world, OPERATOR, 13);

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(true);
  });

  it("release-publish-failure-keeps-item", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.publisher.failure = new Error("broker down");
    const result = await release(world, OPERATOR, 14);

    expect(result).toMatchObject({ ok: false, problem: { type: "upstream-failed", status: 502 } });
    expect(world.locks.items.get(CONTROL_ROBOT)?.holder).toBe(OPERATOR_SUB);
    expect(world.claims.claims.size).toBe(0);
  });

  it("release-store-throws-after-publish-still-succeeds", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.locks.failEveryRelease(new Error("dynamodb throttled"));
    const result = await release(world, OPERATOR, 16);

    expect(result).toMatchObject({
      ok: true,
      value: { changed: true, lock: { held: false, mine: false } },
    });
    expect(world.publisher.published).toHaveLength(1);
    expect(world.relay.changes).toEqual([
      expect.objectContaining({ held: false, cause: "RELEASED" }),
    ]);
    expect(world.audit.records[0]).toMatchObject({ action: "lock.release", result: "SUCCEEDED" });
    expect(world.logger.entries).toEqual([
      expect.objectContaining({
        level: "error",
        message: "lock delete failed after the release publish",
      }),
    ]);
  });

  it("release-lost-condition-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.locks.refuseEveryRelease();
    const result = await release(world, OPERATOR, 15);

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-not-held", status: 409 } });
  });

  it("release-replayed-commandid-after-reacquire-changes-nothing", async () => {
    const world = controlWorld();
    await take(world, OPERATOR, 16);
    await release(world, OPERATOR, 17);
    await take(world, OPERATOR, 18);
    const replay = await release(world, OPERATOR, 17);

    expect(replay.ok && replay.value).toMatchObject({
      changed: false,
      lock: { held: true, mine: true },
    });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(true);
    expect(world.publisher.published).toHaveLength(3);
  });

  it("acquire-retired-robot-409", async () => {
    const world = controlWorld();
    const record = world.robots.records.get(CONTROL_ROBOT);
    if (record === undefined) {
      throw new Error("fixture robot missing");
    }
    world.robots.records.set(CONTROL_ROBOT, { ...record, status: "RETIRING" });
    const result = await take(world, OPERATOR, 19);

    expect(result).toMatchObject({
      ok: false,
      problem: { type: "robot-state-conflict", status: 409 },
    });
    expect(world.calls).not.toContain("locks.acquire");
  });

  it("lock-state-expired-reads-free", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB, -1));
    const result = await getLock(world.deps, OPERATOR, TARGET);

    expect(result).toEqual({
      ok: true,
      value: { robotId: CONTROL_ROBOT, held: false, mine: false },
    });
  });

  it("lock-state-of-another-holder-hides-the-token", () => {
    const item = liveLockOf(OTHER_OPERATOR_SUB);
    const state = lockStateOf(CONTROL_ROBOT, item, OPERATOR_SUB, CONTROL_START_SECONDS);

    expect(state).toMatchObject({ held: true, holder: OTHER_OPERATOR_SUB, mine: false });
    expect(JSON.stringify(state)).not.toContain(FIXTURE_TOKEN);
  });

  it("lock-token-is-43-chars-base64url", () => {
    const token = newLockToken((size) => new Uint8Array(size).fill(0xff));

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(43);
  });

  it("admin-takes-control-like-an-operator", async () => {
    const world = controlWorld();
    const result = await take(world, ADMIN, 20);

    expect(result.ok && result.value.lock.mine).toBe(true);
  });
});
