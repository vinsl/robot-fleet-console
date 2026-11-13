/**
 * Registration use case: the happy path, the failure matrix with compensation, idempotent resumption,
 * refusals, the step budget and log hygiene.
 */
import {
  RegisterRobotResponseSchema,
  RobotKitSchema,
  type RegisterInvokeResult,
  type RegisterRobotResponse,
} from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { AMAZON_ROOT_CA_1_PEM } from "../../../src/domain/robots/amazon-root-ca";
import { registerRobot } from "../../../src/domain/robots/register";
import { RobotsError } from "../../../src/domain/robots/problems";
import type { RobotRecord } from "../../../src/domain/robots/registry";
import { awsError } from "../../fakes/call-gate";
import { FAKE_KEY_BODY } from "../../fakes/fake-iot";
import {
  createWorld,
  recordOf,
  REQUEST,
  START_TIME,
  TEST_CONFIG,
  type World,
} from "../../fakes/world";

const STORED_KEY = "paris-01/kali-01";
const OTHER_CORRELATION = "corr-other-0001";

/** The IoT and video calls of a clean registration, in the order the design fixes. */
const CLEAN_CALLS = [
  "iot.listThingCertificateArns",
  "iot.disconnect",
  "kvs.deleteChannel",
  "iot.createThing",
  "iot.createInactiveCertificate",
  "iot.attachPolicy",
  "iot.attachExclusiveThing",
  "kvs.createChannel",
  "iot.activateCertificate",
];

/**
 * @param result - A registration result.
 * @returns The body of a successful registration; throws when the result is a failure.
 */
function registeredBody(result: RegisterInvokeResult): RegisterRobotResponse {
  if (!result.ok) {
    throw new Error(`expected a registration, got ${result.problem.type}`);
  }
  return result.body;
}

/**
 * Seeds a registry record that is older than the stale threshold, as a crashed registration leaves it.
 *
 * @param world - The world to seed.
 * @param overrides - Fields of the record.
 */
function seedStale(world: World, overrides: Partial<RobotRecord>): void {
  const stale = new Date(START_TIME.getTime() - 121_000).toISOString();
  world.registry.seed(recordOf({ status: "PROVISIONING", updatedAt: stale, ...overrides }));
}

/**
 * @param world - The world.
 * @returns The stored record of the reference robot, or undefined.
 */
function storedRecord(world: World): RobotRecord | undefined {
  return world.registry.items.get(STORED_KEY);
}

describe("registerRobot: happy path", () => {
  it("returns 201 with a valid kit and summary, and records the robot ACTIVE", async () => {
    const world = createWorld();
    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    const body = registeredBody(result);
    expect(RegisterRobotResponseSchema.safeParse(body).success).toBe(true);
    expect(RobotKitSchema.safeParse(body.kit).success).toBe(true);
    expect(body.kit.rootCaPem).toBe(AMAZON_ROOT_CA_1_PEM);
    expect(body.kit.config.thingName).toBe("mfc-demo-kali-01");
    expect(body.kit.config.kvsChannelName).toBe("mfc-demo-kali-01");
    expect(body.kit.config.roleAlias).toBe("mfc-demo-robot-kvs-master");
    expect(body.robot).toStrictEqual({
      robotId: "kali-01",
      siteId: "paris-01",
      name: "Kali 01",
      type: "KALI",
      designDate: "2026-11-02",
      simulated: true,
      status: "ACTIVE",
      createdAt: START_TIME.toISOString(),
    });

    const record = storedRecord(world);
    expect(record?.status).toBe("ACTIVE");
    expect(record?.certificates).toHaveLength(1);
    expect(record?.kvsChannelArn).toBe(body.kit.config.kvsChannelArn);
  });

  it("calls IoT and video in the order the design fixes", async () => {
    const world = createWorld();
    await registerRobot(world.deps, REQUEST, world.invocation());
    expect(world.calls).toStrictEqual(CLEAN_CALLS);
  });

  it("audits the registration as SUCCEEDED and counts it", async () => {
    const world = createWorld();
    await registerRobot(world.deps, REQUEST, world.invocation());

    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      action: "robots.register",
      result: "SUCCEEDED",
      siteId: "paris-01",
      robotId: "kali-01",
      actor: "vincent",
      correlationId: "corr-00000001",
    });
    expect(world.audit.records[0]).not.toHaveProperty("problemType");
    expect(world.metrics.countOf("RobotRegistered")).toBe(1);
  });

  it("keeps the registration when its audit write fails, and counts the failure", async () => {
    const world = createWorld();
    world.audit.gate.fail("write", awsError("InternalFailure"));
    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(world.metrics.countOf("AuditWriteFailed")).toBe(1);
  });
});

describe("registerRobot: failures are compensated", () => {
  const failure = awsError("InternalFailure");
  // Each row names the step that fails and how the test makes it fail.
  const failures: [string, (world: World) => void][] = [
    [
      "CLEANUP",
      (w) => {
        w.iot.gate.fail("listThingCertificateArns", failure);
      },
    ],
    [
      "THING",
      (w) => {
        w.iot.gate.fail("createThing", failure);
      },
    ],
    [
      "CERTIFICATE",
      (w) => {
        w.iot.gate.fail("createInactiveCertificate", failure);
      },
    ],
    ["RECORD_CERTIFICATE", (w) => w.registry.replaceScript.push("conflict")],
    [
      "POLICY",
      (w) => {
        w.iot.gate.fail("attachPolicy", failure);
      },
    ],
    [
      "THING_PRINCIPAL",
      (w) => {
        w.iot.gate.fail("attachExclusiveThing", failure);
      },
    ],
    [
      "CHANNEL",
      (w) => {
        w.kvs.gate.fail("createChannel", failure);
      },
    ],
    [
      "ACTIVATE",
      (w) => {
        w.iot.gate.fail("activateCertificate", failure);
      },
    ],
    ["COMMIT", (w) => w.registry.replaceScript.push("pass", "conflict")],
  ];

  it.each(failures)(
    "a failure at %s returns 502, revokes the certificate, removes the channel and marks the record",
    async (step, arrange) => {
      const world = createWorld();
      arrange(world);

      const result = await registerRobot(world.deps, REQUEST, world.invocation());

      expect(result).toMatchObject({
        ok: false,
        status: 502,
        problem: {
          type: "urn:mfc:problem:provisioning-failed",
          correlationId: "corr-00000001",
        },
      });
      for (const certificate of world.iot.certificates.values()) {
        expect(certificate.status).toBe("REVOKED");
      }
      expect(world.kvs.channels.size).toBe(0);
      expect(storedRecord(world)).toMatchObject({
        status: "PROVISIONING_FAILED",
        failedStep: step,
      });
      expect(world.audit.records.at(-1)).toMatchObject({
        result: "FAILED",
        problemType: "provisioning-failed",
      });
      expect(world.metrics.countOf("RobotRegistrationFailed")).toBe(1);
    },
  );

  it("never returns or logs key material on failure", async () => {
    const world = createWorld();
    world.iot.gate.fail("attachPolicy", awsError("InternalFailure"));
    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("BEGIN CERTIFICATE");
  });

  it("still returns 502 when the compensation itself fails, and counts it", async () => {
    const world = createWorld();
    world.iot.gate.fail("attachPolicy", awsError("InternalFailure"));
    world.iot.gate.fail("revokeCertificate", awsError("InternalFailure"), Number.POSITIVE_INFINITY);

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(world.metrics.countOf("CompensationFailed")).toBe(1);
    expect(storedRecord(world)?.status).toBe("PROVISIONING_FAILED");
  });

  it("still returns 502 when the failure cannot be written to the record, and logs it", async () => {
    const world = createWorld();
    // The first write (RECORD_CERTIFICATE) and the failure mark both fail.
    world.registry.gate.fail("replace", awsError("InternalFailure"), 2);

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({ level: "error", message: "failure not recorded" }),
    );
  });

  it("logs a lost race on the failure mark and still returns 502", async () => {
    const world = createWorld();
    // RECORD_CERTIFICATE and the failure mark both lose their version check.
    world.registry.replaceScript.push("conflict", "conflict");

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({ level: "error", message: "failure not recorded" }),
    );
  });

  it("stops before creating a certificate when less than the step budget is left", async () => {
    const world = createWorld();
    // CLEANUP and THING have budget; CERTIFICATE does not.
    world.deadline.queue(60_000, 60_000, 7_999);

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(world.calls).not.toContain("iot.createInactiveCertificate");
    expect(world.iot.certificates.size).toBe(0);
  });

  it("logs the failing step and the error name, never the message", async () => {
    const world = createWorld();
    world.iot.gate.fail("createThing", awsError("InternalFailure"));
    await registerRobot(world.deps, REQUEST, world.invocation());

    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "registration failed",
        attributes: expect.objectContaining({
          step: "THING",
          errorName: "InternalFailure",
        }) as unknown,
      }),
    );
  });
});

describe("registerRobot: refusals", () => {
  it("refuses an active robot with 409 and makes no IoT or video call", async () => {
    const world = createWorld();
    await registerRobot(world.deps, REQUEST, world.invocation());
    const callsBefore = world.calls.length;

    const result = await registerRobot(world.deps, REQUEST, world.invocation("corr-00000002"));

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-exists" },
    });
    expect(world.calls).toHaveLength(callsBefore);
    expect(world.audit.records.at(-1)).toMatchObject({
      result: "REFUSED",
      problemType: "robot-exists",
    });
    expect(world.metrics.countOf("RobotRegistrationRefused")).toBe(1);
  });

  it("refuses a retired robot id, which is never reused", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ status: "RETIRED", retiredAt: START_TIME.toISOString() }));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-exists" },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("refuses an id claimed by another site, with 409 and no AWS call", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ siteId: "paris-02" }));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-exists" },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a live registration of another invocation with 409 robot-state-conflict", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ status: "PROVISIONING", lastCorrelationId: OTHER_CORRELATION }));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: {
        type: "urn:mfc:problem:robot-state-conflict",
        detail: expect.stringContaining("retry in two minutes") as unknown,
      },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a resumable record with ten certificates, with the too-many-attempts detail", async () => {
    const world = createWorld();
    const certificates = Array.from({ length: 10 }, (_, index) => {
      const id = String(index + 1).padStart(64, "0");
      return { certificateId: id, certificateArn: `arn:aws:iot:eu-west-3:123456789012:cert/${id}` };
    });
    world.registry.seed(recordOf({ status: "PROVISIONING_FAILED", version: 3, certificates }));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { detail: "Too many registration attempts; retire the robot." },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a resume whose version write lost a race, with 409", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ status: "PROVISIONING_FAILED", version: 3 }));
    world.registry.replaceScript.push("conflict");

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: { type: "urn:mfc:problem:robot-state-conflict" },
    });
    expect(world.calls).toHaveLength(0);
  });

  it("answers 500 and audits a FAILED outcome when the registry record is unreadable", async () => {
    const world = createWorld();
    world.registry.seed(recordOf());
    world.registry.gate.fail("get", new RobotsError("internal"));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      problem: { type: "urn:mfc:problem:internal" },
    });
    expect(world.audit.records.at(-1)).toMatchObject({ result: "FAILED", problemType: "internal" });
    expect(world.calls).toHaveLength(0);
  });
});

describe("registerRobot: resumption", () => {
  it("resumes a PROVISIONING_FAILED record and succeeds", async () => {
    const world = createWorld();
    world.registry.seed(
      recordOf({ status: "PROVISIONING_FAILED", failedStep: "POLICY", version: 3 }),
    );

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(storedRecord(world)).toMatchObject({ status: "ACTIVE" });
    expect(storedRecord(world)).not.toHaveProperty("failedStep");
  });

  it("resumes a stale PROVISIONING record: revokes the recorded certificate first, then succeeds", async () => {
    const world = createWorld();
    const old = world.iot.seedAttachedCertificate("kali-01", "paris-01");
    seedStale(world, {
      lastCorrelationId: OTHER_CORRELATION,
      version: 2,
      certificates: [old],
    });

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(world.iot.certificates.get(old.certificateId)?.status).toBe("REVOKED");
    expect(world.calls.indexOf("iot.revokeCertificate")).toBeLessThan(
      world.calls.indexOf("iot.createInactiveCertificate"),
    );
    expect(storedRecord(world)?.certificates).toHaveLength(2);
  });

  it("resumes a stale PROVISIONING record written by this same invocation", async () => {
    const world = createWorld();
    seedStale(world, { version: 1 });

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(storedRecord(world)?.status).toBe("ACTIVE");
  });

  it("refuses a live PROVISIONING record written by this same invocation, as a busy robot", async () => {
    const world = createWorld();
    world.registry.seed(recordOf({ status: "PROVISIONING", version: 1 }));

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      problem: {
        type: "urn:mfc:problem:robot-state-conflict",
        detail: expect.stringContaining("retry in two minutes") as unknown,
      },
    });
    expect(world.calls).toHaveLength(0);
    expect(storedRecord(world)).toMatchObject({ status: "PROVISIONING", version: 1 });
  });

  it("cleans up leftovers of a fresh robot, counts them and logs a warning", async () => {
    const world = createWorld();
    world.iot.seedAttachedCertificate("kali-01", "paris-01");

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(world.metrics.countOf("LeftoverResourcesRemoved")).toBe(1);
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "leftover resources removed" }),
    );
  });

  it("counts and logs a leftover video channel even when no certificate is left", async () => {
    const world = createWorld();
    world.kvs.channels.set("mfc-demo-kali-01", {
      arn: "arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-kali-01/1001",
      tags: TEST_CONFIG.resourceTags,
    });

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(world.calls).toContain("kvs.deleteChannel");
    expect(world.metrics.countOf("LeftoverResourcesRemoved")).toBe(1);
    expect(world.logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "leftover resources removed" }),
    );
  });

  it("neither counts nor logs leftovers when the robot had nothing left behind", async () => {
    const world = createWorld();

    const result = await registerRobot(world.deps, REQUEST, world.invocation());

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(world.metrics.countOf("LeftoverResourcesRemoved")).toBe(0);
    expect(world.logger.entries).not.toContainEqual(
      expect.objectContaining({ message: "leftover resources removed" }),
    );
  });
});

describe("registerRobot: log hygiene", () => {
  it("never logs the key, the certificate body or a key header, on success or on failure", async () => {
    const success = createWorld();
    await registerRobot(success.deps, REQUEST, success.invocation());

    const failure = createWorld();
    failure.iot.gate.fail("activateCertificate", awsError("InternalFailure"));
    await registerRobot(failure.deps, REQUEST, failure.invocation());

    for (const world of [success, failure]) {
      expect(world.logger.text()).not.toContain(FAKE_KEY_BODY);
      expect(world.logger.text()).not.toContain("PRIVATE");
      expect(world.logger.text()).not.toContain("BEGIN CERTIFICATE");
    }
  });
});

describe("registerRobot: unexpected errors", () => {
  it("lets an error that is not a problem escape, for the handler to map to internal", async () => {
    const world = createWorld();
    world.registry.gate.fail("reserve", new Error("connection reset"));

    await expect(registerRobot(world.deps, REQUEST, world.invocation())).rejects.toThrow(
      "connection reset",
    );
  });
});
