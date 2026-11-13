/**
 * Retirement use case: the teardown order, idempotent repeats, resumption after a failed teardown, refusals,
 * and the step budget.
 */
import { ROBOT_POLICY_NAME } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { registerRobot } from "../../../src/domain/robots/register";
import { retireRobot } from "../../../src/domain/robots/retire";
import { awsError } from "../../fakes/call-gate";
import { createWorld, recordOf, REQUEST, START_TIME, type World } from "../../fakes/world";

const RETIRE = { robotId: "kali-01", siteId: "paris-01" } as const;
const STORED_KEY = "paris-01/kali-01";

/**
 * Registers the reference robot so that a retirement has a live identity to remove.
 *
 * @param world - The world to register in.
 */
async function registerActive(world: World): Promise<void> {
  const result = await registerRobot(world.deps, REQUEST, world.invocation());
  if (!result.ok) {
    throw new Error(`setup registration failed: ${result.problem.type}`);
  }
}

describe("retireRobot", () => {
  it("revokes, disconnects, detaches and deletes the channel, then records the robot RETIRED", async () => {
    const world = createWorld();
    await registerActive(world);
    world.calls.splice(0);

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: {
        alreadyRetired: false,
        robot: { status: "RETIRED", retiredAt: START_TIME.toISOString() },
      },
    });
    expect(world.calls).toStrictEqual([
      "iot.listThingCertificateArns",
      "iot.revokeCertificate",
      "iot.disconnect",
      "iot.detachPolicy",
      "iot.detachThing",
      "kvs.deleteChannel",
    ]);
    const record = world.registry.items.get(STORED_KEY);
    expect(record?.status).toBe("RETIRED");
    expect(record).not.toHaveProperty("kvsChannelArn");
    expect(record?.certificates).toHaveLength(1);
    expect(world.metrics.countOf("RobotRetired")).toBe(1);
    expect(world.audit.records.at(-1)).toMatchObject({
      action: "robots.retire",
      result: "SUCCEEDED",
    });
  });

  it("keeps the certificate revoked rather than deleted, and detaches the policy", async () => {
    const world = createWorld();
    await registerActive(world);
    const [certificate] = [...world.iot.certificates.values()];
    expect(certificate?.policies.has(ROBOT_POLICY_NAME)).toBe(true);

    await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(certificate?.status).toBe("REVOKED");
    expect(certificate?.policies.has(ROBOT_POLICY_NAME)).toBe(false);
    expect(certificate?.thingName).toBeNull();
  });

  it("answers a repeat of a retired robot with alreadyRetired true and makes no AWS call", async () => {
    const world = createWorld();
    await registerActive(world);
    await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));
    world.calls.splice(0);

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-02"));

    expect(result).toMatchObject({ ok: true, status: 200, body: { alreadyRetired: true } });
    expect(world.calls).toHaveLength(0);
    expect(world.audit.records.at(-1)).toMatchObject({ result: "SUCCEEDED" });
  });

  it("answers 404 and audits a REFUSED outcome for an unknown robot", async () => {
    const world = createWorld();

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      problem: { type: "urn:mfc:problem:robot-not-found" },
    });
    expect(world.audit.records.at(-1)).toMatchObject({
      result: "REFUSED",
      problemType: "robot-not-found",
    });
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a fresh registration in flight with 409 and no AWS call", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ status: "PROVISIONING", lastCorrelationId: "corr-other-0001" }));

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-state-conflict" },
    });
    expect(world.audit.records.at(-1)).toMatchObject({ result: "REFUSED" });
    expect(world.calls).toHaveLength(0);
  });

  it.each([
    [
      "a stale PROVISIONING record",
      {
        status: "PROVISIONING" as const,
        updatedAt: new Date(START_TIME.getTime() - 121_000).toISOString(),
      },
    ],
    ["a PROVISIONING_FAILED record", { status: "PROVISIONING_FAILED" as const }],
  ])("retires %s", async (_label, overrides) => {
    const world = createWorld();
    world.registry.seed(recordOf(overrides));

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({ ok: true, status: 200, body: { alreadyRetired: false } });
    expect(world.registry.items.get(STORED_KEY)?.status).toBe("RETIRED");
  });

  it("answers 502 and leaves the record RETIRING when a teardown step fails, then completes on repeat", async () => {
    const world = createWorld();
    await registerActive(world);
    world.iot.gate.fail("revokeCertificate", awsError("InternalFailure"));

    const failed = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(failed).toMatchObject({
      ok: false,
      status: 502,
      problem: { type: "urn:mfc:problem:retirement-failed" },
    });
    expect(world.registry.items.get(STORED_KEY)?.status).toBe("RETIRING");
    expect(world.audit.records.at(-1)).toMatchObject({
      result: "FAILED",
      problemType: "retirement-failed",
    });
    expect(world.metrics.countOf("RobotRetirementFailed")).toBe(1);

    const repeated = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-02"));

    expect(repeated).toMatchObject({ ok: true, status: 200, body: { alreadyRetired: false } });
    expect(world.registry.items.get(STORED_KEY)?.status).toBe("RETIRED");
  });

  it("resumes RETIRING under the same correlation identifier without rewriting the record", async () => {
    const world = createWorld();
    world.registry.seed(
      recordOf({ status: "RETIRING", version: 2, lastCorrelationId: "corr-retire-01" }),
    );

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({ ok: true, status: 200 });
    // Version 2 is the RETIRING record; the retirement writes version 3 only, so no extra write happened.
    expect(world.registry.items.get(STORED_KEY)?.version).toBe(3);
  });

  it("answers 409 when the RETIRING write loses a race", async () => {
    const world = createWorld();
    await registerActive(world);
    world.registry.replaceScript.push("conflict");

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-state-conflict" },
    });
    expect(world.calls).not.toContain("iot.revokeCertificate");
  });

  it("answers 502 when the final RETIRED write loses a race", async () => {
    const world = createWorld();
    await registerActive(world);
    world.registry.replaceScript.push("pass", "conflict");

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      problem: { type: "urn:mfc:problem:retirement-failed" },
    });
    expect(world.registry.items.get(STORED_KEY)?.status).toBe("RETIRING");
  });

  it("answers 502 without any teardown call when the invocation has no budget left", async () => {
    const world = createWorld();
    await registerActive(world);
    world.deadline.queue(7_999);
    world.calls.splice(0);

    const result = await retireRobot(world.deps, RETIRE, world.invocation("corr-retire-01"));

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      problem: { type: "urn:mfc:problem:retirement-failed" },
    });
    expect(world.calls).not.toContain("iot.revokeCertificate");
  });
});
