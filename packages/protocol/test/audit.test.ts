/**
 * Audit record schema: the problem type is present exactly when the outcome is not a success, the actor
 * grammar is the admin actor grammar, and nothing beyond the audited facts is accepted.
 */
import { describe, expect, it } from "vitest";
import { ActorSchema, AuditRecordSchema } from "../src/index";

const BASE_RECORD = {
  auditId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
  ts: "2026-11-02T10:00:00.000Z",
  siteId: "paris-01",
  robotId: "kali-01",
  actor: "vincent",
  actorSource: "mfc.admin",
  action: "robots.register",
  correlationId: "corr-0001-abcd",
};

describe("AuditRecordSchema problem type", () => {
  it("accepts a successful outcome without a problem type", () => {
    expect(AuditRecordSchema.safeParse({ ...BASE_RECORD, result: "SUCCEEDED" }).success).toBe(true);
  });

  it.each(["REFUSED", "FAILED"])("refuses a %s outcome without a problem type", (result) => {
    expect(AuditRecordSchema.safeParse({ ...BASE_RECORD, result }).success).toBe(false);
  });

  it("refuses a successful outcome that carries a problem type", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        result: "SUCCEEDED",
        problemType: "robot-exists",
      }).success,
    ).toBe(false);
  });

  it("accepts a refusal with its problem type", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        result: "REFUSED",
        problemType: "robot-exists",
      }).success,
    ).toBe(true);
  });

  it("refuses a problem type outside the published list", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        result: "FAILED",
        problemType: "stack-trace",
      }).success,
    ).toBe(false);
  });
});

describe("AuditRecordSchema fields", () => {
  it("refuses an extra key, so that no internal field is stored by mistake", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        result: "SUCCEEDED",
        certificateArn: "arn:aws:iot:eu-west-3:123456789012:cert/x",
      }).success,
    ).toBe(false);
  });

  it("refuses an action outside the two admin actions", () => {
    expect(
      AuditRecordSchema.safeParse({ ...BASE_RECORD, action: "robots.list", result: "SUCCEEDED" })
        .success,
    ).toBe(false);
  });

  it("refuses an actor source other than the admin invocation", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        actorSource: "cognito",
        result: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });
});

describe("ActorSchema", () => {
  it.each(["vincent", "ci.deploy", "job_42+x", "a"])("accepts %j", (actor) => {
    expect(ActorSchema.safeParse(actor).success).toBe(true);
  });

  it("refuses an e-mail address, which is personal data", () => {
    expect(ActorSchema.safeParse("someone@example.com").success).toBe(false);
  });

  it("refuses an actor longer than 64 characters", () => {
    expect(ActorSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

const SITE_RECORD = {
  auditId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
  ts: "2026-11-03T10:00:00.000Z",
  siteId: "paris-01",
  actor: "vincent",
  actorSource: "mfc.admin",
  correlationId: "corr-0002-abcd",
} as const;

describe("AuditRecordSchema robot and site actions", () => {
  it("accepts a site action that names no robot", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.update",
        result: "SUCCEEDED",
      }).success,
    ).toBe(true);
  });

  it("refuses a site action that names a robot", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.update",
        result: "SUCCEEDED",
        robotId: "kali-01",
      }).success,
    ).toBe(false);
  });

  it("refuses a robot action that names no robot", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "robots.retire",
        result: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it("accepts a map action with its map version", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.map.activate",
        result: "REFUSED",
        problemType: "map-invalid",
        mapVersion: 3,
      }).success,
    ).toBe(true);
  });

  it.each([0, 1.5, "3"])("refuses a map version of %j", (mapVersion) => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.map.create",
        result: "SUCCEEDED",
        mapVersion,
      }).success,
    ).toBe(false);
  });

  it("accepts the JWT actor source of the console", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        actorSource: "mfc.jwt",
        action: "site.update",
        result: "SUCCEEDED",
      }).success,
    ).toBe(true);
  });
});

describe("AuditRecordSchema map version", () => {
  const MAP_ACTIONS = ["site.map.create", "site.map.validate", "site.map.activate"] as const;

  it.each(MAP_ACTIONS)("refuses the map action %s without its map version", (action) => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action,
        result: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });

  it.each(MAP_ACTIONS)("accepts the map action %s with its map version", (action) => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action,
        result: "SUCCEEDED",
        mapVersion: 7,
      }).success,
    ).toBe(true);
  });

  it("refuses a site update that names a map version", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.update",
        result: "SUCCEEDED",
        mapVersion: 7,
      }).success,
    ).toBe(false);
  });

  it("refuses a robot action that names a map version", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...BASE_RECORD,
        action: "robots.register",
        result: "SUCCEEDED",
        mapVersion: 7,
      }).success,
    ).toBe(false);
  });

  it.each([1_000_000, -1])(
    "refuses a map version of %j outside the version grammar",
    (mapVersion) => {
      expect(
        AuditRecordSchema.safeParse({
          ...SITE_RECORD,
          action: "site.map.create",
          result: "SUCCEEDED",
          mapVersion,
        }).success,
      ).toBe(false);
    },
  );

  it("accepts the largest map version of the grammar", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.map.create",
        result: "SUCCEEDED",
        mapVersion: 999_999,
      }).success,
    ).toBe(true);
  });
});

const ALERT_ID = "0123456789abcdef0123456789abcdef";

describe("AuditRecordSchema alert actions", () => {
  const ALERT_RECORD = {
    ...SITE_RECORD,
    siteId: "paris-01",
    robotId: "sim-01",
    alertId: ALERT_ID,
    actor: "3f1c2b4a-1111-2222-3333-444455556666",
    actorSource: "mfc.jwt",
    result: "SUCCEEDED",
  } as const;

  it.each(["alert.acknowledge", "alert.resolve"] as const)(
    "accepts %s naming its robot and its alert",
    (action) => {
      expect(AuditRecordSchema.safeParse({ ...ALERT_RECORD, action }).success).toBe(true);
    },
  );

  it.each(["alert.acknowledge", "alert.resolve"] as const)(
    "refuses %s without a robot",
    (action) => {
      const withoutRobot = Object.fromEntries(
        Object.entries(ALERT_RECORD).filter(([key]) => key !== "robotId"),
      );
      expect(AuditRecordSchema.safeParse({ ...withoutRobot, action }).success).toBe(false);
    },
  );

  it.each(["alert.acknowledge", "alert.resolve"] as const)(
    "refuses %s without an alert id",
    (action) => {
      const withoutAlert = Object.fromEntries(
        Object.entries(ALERT_RECORD).filter(([key]) => key !== "alertId"),
      );
      expect(AuditRecordSchema.safeParse({ ...withoutAlert, action }).success).toBe(false);
    },
  );

  it("refuses a site action that names an alert", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "site.update",
        result: "SUCCEEDED",
        alertId: ALERT_ID,
      }).success,
    ).toBe(false);
  });

  it("refuses a robot action that names an alert", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...ALERT_RECORD,
        action: "robots.retire",
        alertId: ALERT_ID,
      }).success,
    ).toBe(false);
  });

  it("still accepts a robot action that names a robot and no alert", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...SITE_RECORD,
        action: "robots.register",
        result: "SUCCEEDED",
        robotId: "sim-01",
      }).success,
    ).toBe(true);
  });

  it("refuses an alert id that is not 32 lowercase hexadecimal characters", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...ALERT_RECORD,
        action: "alert.resolve",
        alertId: ALERT_ID.toUpperCase(),
      }).success,
    ).toBe(false);
  });
});

describe("AuditRecordSchema control actions", () => {
  const COMMAND_ID = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9e";
  const CONTROL_BASE = {
    ...BASE_RECORD,
    actor: "3f1c2b4a",
    actorSource: "mfc.jwt",
    result: "SUCCEEDED",
  };

  it("accepts a command action with its robot and its command identifier", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...CONTROL_BASE,
        action: "command.pause",
        commandId: COMMAND_ID,
      }).success,
    ).toBe(true);
  });

  it("refuses a command action without its command identifier", () => {
    expect(AuditRecordSchema.safeParse({ ...CONTROL_BASE, action: "command.pause" }).success).toBe(
      false,
    );
  });

  it("refuses a command action without its robot", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...CONTROL_BASE,
        robotId: undefined,
        action: "command.estop",
        commandId: COMMAND_ID,
      }).success,
    ).toBe(false);
  });

  it("refuses a command identifier on an action that is not a command", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...CONTROL_BASE,
        action: "lock.acquire",
        commandId: COMMAND_ID,
      }).success,
    ).toBe(false);
  });

  it("accepts a refused command with its problem type", () => {
    expect(
      AuditRecordSchema.safeParse({
        ...CONTROL_BASE,
        action: "command.resume",
        commandId: COMMAND_ID,
        result: "REFUSED",
        problemType: "lock-not-held",
      }).success,
    ).toBe(true);
  });

  it("accepts a lock action with its robot and no command identifier", () => {
    expect(AuditRecordSchema.safeParse({ ...CONTROL_BASE, action: "lock.acquire" }).success).toBe(
      true,
    );
  });

  it("refuses a lock action without its robot", () => {
    expect(
      AuditRecordSchema.safeParse({ ...CONTROL_BASE, robotId: undefined, action: "lock.release" })
        .success,
    ).toBe(false);
  });

  it("refuses a demo action that names a robot", () => {
    expect(AuditRecordSchema.safeParse({ ...CONTROL_BASE, action: "demo.enable" }).success).toBe(
      false,
    );
  });

  it("accepts a demo action that names no robot", () => {
    expect(
      AuditRecordSchema.safeParse({ ...CONTROL_BASE, robotId: undefined, action: "demo.disable" })
        .success,
    ).toBe(true);
  });
});
