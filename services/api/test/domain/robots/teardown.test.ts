/**
 * Teardown of a robot's live identity: order, idempotency, principal filtering and the step budget.
 */
import { ROBOT_POLICY_NAME } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  assertStepBudget,
  MIN_STEP_BUDGET_MS,
  teardownRobotResources,
} from "../../../src/domain/robots/teardown";
import { RobotsError } from "../../../src/domain/robots/problems";
import { ScriptedDeadline } from "../../fakes/fixed";
import { awsError } from "../../fakes/call-gate";
import { createWorld } from "../../fakes/world";

describe("teardownRobotResources", () => {
  it("revokes, ends the session, detaches and deletes the channel, in that order", async () => {
    const world = createWorld();
    const cert = world.iot.seedAttachedCertificate("kali-01", "paris-01");
    await world.iot.attachPolicy(ROBOT_POLICY_NAME, cert.certificateArn);
    await world.kvs.createChannel("mfc-demo-kali-01", world.deps.config.resourceTags);
    world.calls.splice(0);

    const report = await teardownRobotResources(world.deps, {
      thingName: "mfc-demo-kali-01",
      knownCertificates: [cert],
    });

    expect(report).toStrictEqual({ revoked: 1, channelDeleted: true });
    expect(world.calls).toStrictEqual([
      "iot.listThingCertificateArns",
      "iot.revokeCertificate",
      "iot.disconnect",
      "iot.detachPolicy",
      "iot.detachThing",
      "kvs.deleteChannel",
    ]);
    expect(world.iot.certificates.get(cert.certificateId)?.status).toBe("REVOKED");
    expect(world.iot.certificates.get(cert.certificateId)?.policies.size).toBe(0);
    expect(world.iot.disconnects).toStrictEqual(["mfc-demo-kali-01"]);
  });

  it("removes a certificate known to the registry and also attached to the thing only once", async () => {
    const world = createWorld();
    const cert = world.iot.seedAttachedCertificate("kali-01", "paris-01");

    const report = await teardownRobotResources(world.deps, {
      thingName: "mfc-demo-kali-01",
      knownCertificates: [cert],
    });

    expect(report.revoked).toBe(1);
    expect(world.calls.filter((call) => call === "iot.revokeCertificate")).toHaveLength(1);
  });

  it("finds and revokes attached certificates the registry does not know", async () => {
    const world = createWorld();
    world.iot.seedAttachedCertificate("kali-01", "paris-01");

    const report = await teardownRobotResources(world.deps, {
      thingName: "mfc-demo-kali-01",
      knownCertificates: [],
    });

    expect(report).toStrictEqual({ revoked: 1, channelDeleted: false });
  });

  it("skips a principal that is not a certificate, with a warning that carries no ARN", async () => {
    const world = createWorld();
    world.iot.seedAttachedCertificate("kali-01", "paris-01");
    const thing = world.iot.things.get("mfc-demo-kali-01");
    thing?.principals.add("arn:aws:cognito-identity:eu-west-3:123456789012:pool/example");

    const report = await teardownRobotResources(world.deps, {
      thingName: "mfc-demo-kali-01",
      knownCertificates: [],
    });

    expect(report.revoked).toBe(1);
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "non-certificate principal skipped" }),
    );
    expect(world.logger.text()).not.toContain("cognito");
  });

  it("is idempotent: an absent thing and an absent channel are not errors", async () => {
    const world = createWorld();
    const report = await teardownRobotResources(world.deps, {
      thingName: "mfc-demo-kali-01",
      knownCertificates: [],
    });
    expect(report).toStrictEqual({ revoked: 0, channelDeleted: false });
  });

  it("propagates an unexpected error from IoT", async () => {
    const world = createWorld();
    const cert = world.iot.seedAttachedCertificate("kali-01", "paris-01");
    world.iot.gate.fail("revokeCertificate", awsError("InternalFailure"));

    await expect(
      teardownRobotResources(world.deps, {
        thingName: "mfc-demo-kali-01",
        knownCertificates: [cert],
      }),
    ).rejects.toThrow("InternalFailure");
  });
});

describe("assertStepBudget", () => {
  it("refuses a step with less than the minimum budget left", () => {
    const deadline = new ScriptedDeadline(MIN_STEP_BUDGET_MS - 1);
    expect(() => {
      assertStepBudget(deadline);
    }).toThrow(RobotsError);
  });

  it("allows a step with exactly the minimum budget left", () => {
    expect(() => {
      assertStepBudget(new ScriptedDeadline(MIN_STEP_BUDGET_MS));
    }).not.toThrow();
  });
});
