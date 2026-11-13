/**
 * Use case `sendCommand`: the policy, the lock, the claim, the publish and the audit of a controlled command.
 */
import { commandTopic, type CommandRequest } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { sendCommand, type CommandTarget } from "../../../src/domain/control/send-command";
import {
  ADMIN,
  CONTROL_ROBOT,
  CONTROL_SITE,
  CONTROL_START_SECONDS,
  FIXTURE_TOKEN,
  OPERATOR,
  OPERATOR_SUB,
  OTHER_OPERATOR_SUB,
  REAL_ROBOT,
  commandIdOf,
  controlWorld,
  liveLockOf,
  robotOf,
  sentCommandOf,
  type ControlWorld,
} from "../../fakes/control";
import type { Principal } from "../../../src/domain/authz";

const TARGET: CommandTarget = { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT };
const VIEWER: Principal = {
  userId: "00000000-0000-4000-8000-0000000000b1",
  role: "Viewer",
  siteId: CONTROL_SITE,
};

/**
 * Sends one command through the use case of a world.
 *
 * @param world - The control world.
 * @param principal - The caller.
 * @param request - The command request.
 * @param remainingMs - Time left in the invocation.
 * @returns The use case outcome.
 */
function send(
  world: ControlWorld,
  principal: Principal,
  request: CommandRequest,
  remainingMs = 5000,
  target: CommandTarget = TARGET,
) {
  return sendCommand(world.deps, principal, target, request, world.callWith(remainingMs));
}

describe("sendCommand", () => {
  it("command-published-with-lock", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const result = await send(world, OPERATOR, { commandId: commandIdOf(1), type: "PAUSE" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deduplicated).toBe(false);
      expect(result.value.commandId).toBe(commandIdOf(1));
    }
    expect(world.publisher.published).toHaveLength(1);
    expect(world.publisher.published[0]?.topic).toBe(commandTopic(CONTROL_SITE, CONTROL_ROBOT));
    const command = sentCommandOf(world);
    expect(command.type).toBe("PAUSE");
    expect(command.lockToken).toBe(FIXTURE_TOKEN);
    expect(command.issuedBy).toBe(OPERATOR_SUB);
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "command.pause",
      result: "SUCCEEDED",
      commandId: commandIdOf(1),
      actorSource: "mfc.jwt",
    });
  });

  it("command-without-lock-409", async () => {
    const world = controlWorld();
    const result = await send(world, OPERATOR, { commandId: commandIdOf(2), type: "PAUSE" });

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-not-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.claims.claims.size).toBe(0);
    expect(world.calls).not.toContain("claims.claim");
    expect(world.audit.records[0]).toMatchObject({
      action: "command.pause",
      result: "REFUSED",
      problemType: "lock-not-held",
    });
  });

  it("command-other-holder-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OTHER_OPERATOR_SUB));
    const result = await send(world, OPERATOR, { commandId: commandIdOf(3), type: "RESUME" });

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-not-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.claims.claims.size).toBe(0);
  });

  it("command-expired-lock-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB, -5));
    const result = await send(world, OPERATOR, {
      commandId: commandIdOf(4),
      type: "RETURN_TO_BASE",
    });

    expect(result).toMatchObject({ ok: false, problem: { type: "lock-not-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);
  });

  it("replayed-command-deduplicated", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const first = await send(world, OPERATOR, { commandId: commandIdOf(5), type: "PAUSE" });
    const second = await send(world, OPERATOR, { commandId: commandIdOf(5), type: "PAUSE" });

    expect(first.ok && first.value.deduplicated).toBe(false);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toMatchObject({
        deduplicated: true,
        correlationId: first.value.correlationId,
        issuedAt: first.value.issuedAt,
      });
    }
    expect(world.publisher.published).toHaveLength(1);
    expect(world.metrics.value("CommandDeduplicated")).toBe(1);
  });

  it("replayed-id-other-actor-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    await send(world, OPERATOR, { commandId: commandIdOf(6), type: "PAUSE" });
    const other: Principal = { userId: OTHER_OPERATOR_SUB, role: "Operator", siteId: CONTROL_SITE };
    world.locks.put(liveLockOf(OTHER_OPERATOR_SUB));
    const result = await send(world, other, { commandId: commandIdOf(6), type: "PAUSE" });

    expect(result).toMatchObject({ ok: false, problem: { type: "command-conflict", status: 409 } });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("replayed-id-other-type-409", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    await send(world, OPERATOR, { commandId: commandIdOf(7), type: "PAUSE" });
    const result = await send(world, OPERATOR, { commandId: commandIdOf(7), type: "RESUME" });

    expect(result).toMatchObject({ ok: false, problem: { type: "command-conflict", status: 409 } });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("publish-failure-502-and-retryable", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.publisher.failure = new Error("broker down");
    const failed = await send(world, OPERATOR, { commandId: commandIdOf(8), type: "PAUSE" });

    expect(failed).toMatchObject({ ok: false, problem: { type: "upstream-failed", status: 502 } });
    expect(world.claims.claims.size).toBe(0);
    expect(world.audit.records[0]).toMatchObject({
      action: "command.pause",
      result: "FAILED",
      problemType: "upstream-failed",
    });

    world.publisher.failure = undefined;
    const retried = await send(world, OPERATOR, { commandId: commandIdOf(8), type: "PAUSE" });
    expect(retried.ok && retried.value.deduplicated).toBe(false);
    expect(world.publisher.published).toHaveLength(1);
  });

  it("estop-without-lock", async () => {
    const world = controlWorld();
    const result = await send(world, OPERATOR, { commandId: commandIdOf(9), type: "ESTOP" });

    expect(result.ok).toBe(true);
    expect(world.publisher.published).toHaveLength(1);
    const command = sentCommandOf(world);
    expect(command.type).toBe("ESTOP");
    expect(command.lockToken).toBeUndefined();
  });

  it("estop-replayed-commandid-publishes-nothing", async () => {
    const world = controlWorld();
    await send(world, OPERATOR, { commandId: commandIdOf(10), type: "ESTOP" });
    const replay = await send(world, OPERATOR, { commandId: commandIdOf(10), type: "ESTOP" });

    expect(replay.ok && replay.value.deduplicated).toBe(true);
    expect(world.publisher.published).toHaveLength(1);
  });

  it("estop-audit-failure-still-200", async () => {
    const world = controlWorld();
    world.audit.failure = new Error("audit table throttled");
    const result = await send(world, OPERATOR, { commandId: commandIdOf(11), type: "ESTOP" });

    expect(result.ok).toBe(true);
    expect(world.publisher.published).toHaveLength(1);
    expect(world.metrics.value("AuditWriteFailed")).toBe(1);
  });

  it("estop-published-before-audit", async () => {
    const world = controlWorld();
    await send(world, OPERATOR, { commandId: commandIdOf(12), type: "ESTOP" });

    const publishAt = world.calls.indexOf("publisher.publish");
    const auditAt = world.calls.indexOf("audit.write");
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeGreaterThan(publishAt);
  });

  it("estop-published-with-short-time-left", async () => {
    const world = controlWorld();
    const result = await send(world, OPERATOR, { commandId: commandIdOf(13), type: "ESTOP" }, 1000);

    expect(result.ok).toBe(true);
    expect(world.publisher.published).toHaveLength(1);
  });

  it("estop-release-needs-lock", async () => {
    const world = controlWorld();
    const refused = await send(world, OPERATOR, {
      commandId: commandIdOf(14),
      type: "ESTOP_RELEASE",
    });
    expect(refused).toMatchObject({ ok: false, problem: { type: "lock-not-held", status: 409 } });
    expect(world.publisher.published).toEqual([]);

    world.locks.put(liveLockOf(OPERATOR_SUB));
    const accepted = await send(world, OPERATOR, {
      commandId: commandIdOf(15),
      type: "ESTOP_RELEASE",
    });
    expect(accepted.ok).toBe(true);
    expect(sentCommandOf(world).lockToken).toBe(FIXTURE_TOKEN);
  });

  it("retired-robot-409", async () => {
    const world = controlWorld();
    world.robots.records.set(
      CONTROL_ROBOT,
      robotOf(CONTROL_ROBOT, { status: "RETIRED", retiredAt: "2026-11-03T10:00:00.000Z" }),
    );
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const result = await send(world, OPERATOR, { commandId: commandIdOf(16), type: "PAUSE" });

    expect(result).toMatchObject({
      ok: false,
      problem: { type: "robot-state-conflict", status: 409 },
    });
    expect(world.publisher.published).toEqual([]);
  });

  it("unknown-robot-404", async () => {
    const world = controlWorld();
    const result = await send(
      world,
      OPERATOR,
      { commandId: commandIdOf(17), type: "PAUSE" },
      5000,
      {
        siteId: CONTROL_SITE,
        robotId: "sim-09",
      },
    );

    expect(result).toMatchObject({ ok: false, problem: { type: "robot-not-found", status: 404 } });
    expect(world.claims.claims.size).toBe(0);
    expect(world.publisher.published).toEqual([]);
  });

  it("fault-operator-403", async () => {
    const world = controlWorld();
    world.demo.state = { enabled: true };
    const result = await send(world, OPERATOR, {
      commandId: commandIdOf(18),
      type: "SIMULATE_FAULT",
      params: { fault: "SENSOR_FAULT" },
    });

    expect(result).toMatchObject({ ok: false, problem: { type: "forbidden", status: 403 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "command.simulate_fault",
        result: "REFUSED",
        problemType: "forbidden",
        commandId: commandIdOf(18),
        robotId: CONTROL_ROBOT,
      }),
    ]);
    expect(JSON.stringify(world.audit.records)).not.toContain("SENSOR_FAULT");
  });

  it("fault-demo-off-409", async () => {
    const world = controlWorld();
    const result = await send(world, ADMIN, {
      commandId: commandIdOf(19),
      type: "SIMULATE_FAULT",
      params: { fault: "SENSOR_FAULT" },
    });

    expect(result).toMatchObject({ ok: false, problem: { type: "demo-mode-off", status: 409 } });
    expect(world.publisher.published).toEqual([]);
  });

  it("fault-on-real-robot-409", async () => {
    const world = controlWorld();
    world.demo.state = { enabled: true };
    const result = await send(
      world,
      ADMIN,
      { commandId: commandIdOf(20), type: "SIMULATE_FAULT", params: { fault: "OBSTACLE" } },
      5000,
      {
        siteId: CONTROL_SITE,
        robotId: REAL_ROBOT,
      },
    );

    expect(result).toMatchObject({ ok: false, problem: { type: "not-simulated", status: 409 } });
    expect(world.publisher.published).toEqual([]);
  });

  it("a non-simulated robot gets not-simulated and nothing is published", async () => {
    // The lock is held, so the only thing left to refuse the fault is the simulated flag: the robot must not be reached.
    const world = controlWorld();
    world.demo.state = { enabled: true };
    world.locks.put(liveLockOf(ADMIN.userId, 30, REAL_ROBOT));
    const result = await send(
      world,
      ADMIN,
      { commandId: commandIdOf(21), type: "SIMULATE_FAULT", params: { fault: "BATTERY_LOW" } },
      5000,
      {
        siteId: CONTROL_SITE,
        robotId: REAL_ROBOT,
      },
    );

    expect(result).toMatchObject({ ok: false, problem: { type: "not-simulated", status: 409 } });
    expect(world.publisher.published).toEqual([]);
    expect(world.claims.claims.size).toBe(0);
    expect(world.audit.records[0]).toMatchObject({
      action: "command.simulate_fault",
      result: "REFUSED",
      problemType: "not-simulated",
    });
  });

  it("fault-ok", async () => {
    const world = controlWorld();
    world.demo.state = { enabled: true };
    const result = await send(world, ADMIN, {
      commandId: commandIdOf(22),
      type: "SIMULATE_FAULT",
      params: { fault: "LINK_LOSS", durationS: 20 },
    });

    expect(result.ok).toBe(true);
    const command = sentCommandOf(world);
    expect(command.type).toBe("SIMULATE_FAULT");
    expect(command.params).toEqual({ fault: "LINK_LOSS", durationS: 20 });
    expect(world.audit.records[0]).toMatchObject({
      action: "command.simulate_fault",
      result: "SUCCEEDED",
    });
    expect(world.metrics.value("FaultInjected")).toBe(1);
  });

  it("late-call-503-no-publish", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const result = await send(world, OPERATOR, { commandId: commandIdOf(23), type: "PAUSE" }, 1000);

    expect(result).toMatchObject({ ok: false, problem: { type: "upstream-failed", status: 503 } });
    expect(world.publisher.published).toEqual([]);
    // No claim either: a claim left behind would turn the retry into a deduplicated answer for a command never sent.
    expect(world.claims.claims.size).toBe(0);
  });

  it("refreshes a lock that is close to expiry", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB, 15));
    await send(world, OPERATOR, { commandId: commandIdOf(24), type: "PAUSE" });

    expect(world.locks.lastRefreshExpiry).toBe(CONTROL_START_SECONDS + 30);
  });

  it("does not refresh a fresh lock", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB, 30));
    await send(world, OPERATOR, { commandId: commandIdOf(25), type: "PAUSE" });

    expect(world.calls).not.toContain("locks.refresh");
  });

  it("e-stop publishes when the registry read throws", async () => {
    const world = controlWorld();
    world.robots.failure = new Error("dynamodb throttled");
    const result = await send(world, OPERATOR, { commandId: commandIdOf(30), type: "ESTOP" });

    expect(result).toMatchObject({ ok: true, value: { deduplicated: false } });
    expect(world.publisher.published).toHaveLength(1);
    expect(sentCommandOf(world).type).toBe("ESTOP");
    expect(world.logger.entries).toEqual([
      expect.objectContaining({
        level: "error",
        message: "robot registry read failed during e-stop",
      }),
    ]);
    expect(JSON.stringify(world.logger.entries)).not.toContain("dynamodb throttled");
  });

  it("a registry read failure still refuses a pause, before any publish", async () => {
    const world = controlWorld();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    world.robots.failure = new Error("dynamodb throttled");

    await expect(
      send(world, OPERATOR, { commandId: commandIdOf(31), type: "PAUSE" }),
    ).rejects.toThrow("dynamodb throttled");
    expect(world.publisher.published).toEqual([]);
  });

  it("e-stop publishes when the claim store throws", async () => {
    const world = controlWorld();
    world.claims.failure = new Error("dynamodb throttled");
    const result = await send(world, OPERATOR, { commandId: commandIdOf(32), type: "ESTOP" });

    expect(result).toMatchObject({ ok: true, value: { deduplicated: false } });
    expect(world.publisher.published).toHaveLength(1);
    expect(world.logger.entries).toEqual([
      expect.objectContaining({ level: "error", message: "command claim failed during e-stop" }),
    ]);
  });

  it("e-stop to a retiring robot is published", async () => {
    const world = controlWorld();
    world.robots.records.set(CONTROL_ROBOT, robotOf(CONTROL_ROBOT, { status: "RETIRING" }));
    const result = await send(world, OPERATOR, { commandId: commandIdOf(33), type: "ESTOP" });

    expect(result).toMatchObject({ ok: true, value: { deduplicated: false } });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("e-stop to a retiring robot is still refused for a robot that does not exist", async () => {
    const world = controlWorld();
    const result = await send(
      world,
      OPERATOR,
      { commandId: commandIdOf(34), type: "ESTOP" },
      5000,
      { siteId: CONTROL_SITE, robotId: "sim-99" },
    );

    expect(result).toMatchObject({ ok: false, problem: { type: "robot-not-found", status: 404 } });
    expect(world.publisher.published).toEqual([]);
  });

  it("a failed audit write does not fail a published e-stop", async () => {
    const world = controlWorld();
    world.audit.failure = new Error("audit table throttled");
    const result = await send(world, OPERATOR, { commandId: commandIdOf(35), type: "ESTOP" });

    expect(result).toMatchObject({
      ok: true,
      value: { commandId: commandIdOf(35), correlationId: "corr-00000001", deduplicated: false },
    });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("refuses a viewer by the policy table, before any store read, and audits the refusal", async () => {
    const world = controlWorld();
    const result = await send(world, VIEWER, { commandId: commandIdOf(26), type: "PAUSE" });

    expect(result).toMatchObject({ ok: false, problem: { type: "forbidden", status: 403 } });
    expect(world.calls).toEqual(["audit.write"]);
    expect(world.audit.records[0]).toMatchObject({ action: "command.pause", result: "REFUSED" });
  });
});
