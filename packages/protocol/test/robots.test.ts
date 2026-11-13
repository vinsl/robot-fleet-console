/**
 * Robot registry and kit schemas: name grammar, the PEM bounds, and the strictness of each request.
 */
import { describe, expect, it } from "vitest";
import {
  KvsChannelArnSchema,
  RegisterRobotRequestSchema,
  RobotKitSchema,
  VideoStatusSchema,
} from "../src/index";

const REGISTER = {
  robotId: "kali-01",
  siteId: "paris-01",
  name: "Kali robot",
  type: "AMR-7",
  designDate: "2026-10-30",
  simulated: false,
};

/** Labels of the two private key forms, kept apart from the header so that the source holds no key header. */
const PKCS8_LABEL = "PRIVATE KEY";
const RSA_LABEL = "RSA PRIVATE KEY";

/** Builds a PEM block around a body, using the label only at run time (see the fixture test). */
function pem(kind: string, body: string): string {
  return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\n`;
}

describe("RobotKitSchema PEM blocks", () => {
  const schema = RobotKitSchema.shape.privateKeyPem;

  it("refuses a private key block that has a header but no footer", () => {
    const truncated = `-----BEGIN ${PKCS8_LABEL}-----\nMIIBVQIBAD\n`;
    expect(schema.safeParse(truncated).success).toBe(false);
  });

  it("accepts the PKCS#1 form and the PKCS#8 form", () => {
    expect(schema.safeParse(pem(RSA_LABEL, "MIIBVQIBAD")).success).toBe(true);
    expect(schema.safeParse(pem(PKCS8_LABEL, "MIIBVQIBAD")).success).toBe(true);
  });

  it("refuses a block whose footer names another form than its header", () => {
    const mismatched = `-----BEGIN ${RSA_LABEL}-----\nMIIBVQIBAD\n-----END ${PKCS8_LABEL}-----\n`;
    expect(schema.safeParse(mismatched).success).toBe(false);
  });

  it("refuses a PEM block larger than 4096 characters", () => {
    const oversized = pem("PRIVATE KEY", "A".repeat(4097));
    expect(schema.safeParse(oversized).success).toBe(false);
  });

  it("refuses a block with a carriage return, which the parser of the robot does not expect", () => {
    expect(schema.safeParse(pem("PRIVATE KEY", "MIIB\r\nVQ")).success).toBe(false);
  });
});

describe("RegisterRobotRequestSchema", () => {
  it("accepts accented Latin letters used in French names", () => {
    expect(
      RegisterRobotRequestSchema.safeParse({ ...REGISTER, name: "Robot Équipe-2" }).success,
    ).toBe(true);
  });

  it("refuses a name longer than 64 characters", () => {
    expect(
      RegisterRobotRequestSchema.safeParse({ ...REGISTER, name: "a".repeat(65) }).success,
    ).toBe(false);
  });

  it("refuses a request that names a status, which the caller must not choose", () => {
    expect(RegisterRobotRequestSchema.safeParse({ ...REGISTER, status: "ACTIVE" }).success).toBe(
      false,
    );
  });
});

describe("KvsChannelArnSchema", () => {
  it("accepts a channel named after a thing in an allowed region", () => {
    expect(
      KvsChannelArnSchema.safeParse(
        "arn:aws:kinesisvideo:eu-west-3:111122223333:channel/mfc-demo-kali-01/1700000000000",
      ).success,
    ).toBe(true);
  });

  it("refuses a channel in another region", () => {
    expect(
      KvsChannelArnSchema.safeParse(
        "arn:aws:kinesisvideo:us-east-1:111122223333:channel/mfc-demo-kali-01/1700000000000",
      ).success,
    ).toBe(false);
  });
});

describe("VideoStatusSchema", () => {
  it("refuses a status that reports the cloud-only OFFLINE state", () => {
    expect(
      VideoStatusSchema.safeParse({ state: "OFFLINE", banner: "NONE", lockHeld: false }).success,
    ).toBe(false);
  });
});
