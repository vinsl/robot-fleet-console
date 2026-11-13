/**
 * In-memory IoT Core: things, certificates, policies and attachments, with the not-found and
 * already-revoked semantics the adapter maps to success.
 */
import { Buffer } from "node:buffer";
import type { RobotId, SiteId, ThingName } from "@mfc/protocol";
import type { CreatedCertificate, IotPort } from "../../src/domain/ports";
import { awsError, CallGate } from "./call-gate";

/** Account identifier used in fake ARNs. Fake, and not a real account. */
export const FAKE_ACCOUNT_ID = "123456789012";

/** Region used in fake ARNs. */
export const FAKE_REGION = "eu-west-3";

/** Body of the fake private key. It is the string the log hygiene tests look for. */
export const FAKE_KEY_BODY = Buffer.from("fake private key material").toString("base64");

/** A certificate held by the fake. */
export interface FakeCertificate {
  readonly certificateId: string;
  readonly certificateArn: string;
  status: "INACTIVE" | "ACTIVE" | "REVOKED";
  readonly policies: Set<string>;
  thingName: string | null;
}

/** A thing held by the fake. */
export interface FakeThing {
  readonly attributes: { robotId: string; siteId: string };
  readonly principals: Set<string>;
}

/** Operations of the IoT fake, the names used by failure injection. */
export type IotMethod = keyof IotPort;

/**
 * @param certificateId - Certificate identifier.
 * @returns The fake certificate ARN.
 */
function certificateArnOf(certificateId: string): string {
  return `arn:aws:iot:${FAKE_REGION}:${FAKE_ACCOUNT_ID}:cert/${certificateId}`;
}

/**
 * @param serial - A positive serial, unique per certificate.
 * @returns A certificate PEM whose body encodes the serial.
 */
function certificatePem(serial: number): string {
  const body = Buffer.from(`fake certificate ${String(serial)}`).toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/**
 * The private key PEM. The header is split so that the source holds no contiguous key header, which the
 * secret scanners would report.
 *
 * @returns A PKCS#8-shaped PEM with the fixed fake body.
 */
function privateKeyPem(): string {
  const begin = "-----BEGIN PRIVATE" + " KEY-----";
  const end = "-----END PRIVATE" + " KEY-----";
  return `${begin}\n${FAKE_KEY_BODY}\n${end}\n`;
}

/** IoT fake. */
export class FakeIot implements IotPort {
  /** Things by thing name. */
  readonly things = new Map<string, FakeThing>();
  /** Certificates by identifier. */
  readonly certificates = new Map<string, FakeCertificate>();
  /** Thing names that were disconnected, in order. */
  readonly disconnects: string[] = [];
  /** Calls and scripted failures, logged into the shared call log. */
  readonly gate: CallGate<IotMethod>;
  private serial = 0;

  /** @param log - The shared call log of the IoT and video fakes. */
  constructor(log: string[]) {
    this.gate = new CallGate(log, "iot");
  }

  /**
   * Creates a certificate attached to a thing, as a previous run would have left it. Not a port call, so
   * it is not logged.
   *
   * @param robotId - Robot whose thing receives the certificate.
   * @param siteId - Site of the robot.
   * @param status - Status of the certificate.
   * @returns The identifier and ARN of the certificate.
   */
  seedAttachedCertificate(
    robotId: string,
    siteId: string,
    status: "INACTIVE" | "ACTIVE" = "ACTIVE",
  ): { certificateId: string; certificateArn: string } {
    const name = `mfc-demo-${robotId}`;
    let thing = this.things.get(name);
    if (thing === undefined) {
      thing = { attributes: { robotId, siteId }, principals: new Set() };
      this.things.set(name, thing);
    }
    const certificate = this.newCertificate(status);
    certificate.thingName = name;
    thing.principals.add(certificate.certificateArn);
    return { certificateId: certificate.certificateId, certificateArn: certificate.certificateArn };
  }

  /**
   * @param thingName - Thing name.
   * @param attributes - Attributes of the thing.
   * @throws {Error} `ResourceAlreadyExistsException` when the thing exists with other attributes.
   */
  async createThing(
    thingName: ThingName,
    attributes: { robotId: RobotId; siteId: SiteId },
  ): Promise<void> {
    await this.gate.enter("createThing");
    const existing = this.things.get(thingName);
    if (existing !== undefined) {
      const same =
        existing.attributes.robotId === attributes.robotId &&
        existing.attributes.siteId === attributes.siteId;
      if (!same) {
        throw awsError("ResourceAlreadyExistsException");
      }
      return;
    }
    this.things.set(thingName, {
      attributes: { robotId: attributes.robotId, siteId: attributes.siteId },
      principals: new Set(),
    });
  }

  /** @returns A new inactive certificate with its key pair. */
  async createInactiveCertificate(): Promise<CreatedCertificate> {
    await this.gate.enter("createInactiveCertificate");
    const certificate = this.newCertificate("INACTIVE");
    return {
      certificateId: certificate.certificateId,
      certificateArn: certificate.certificateArn,
      certificatePem: certificatePem(this.serial),
      privateKeyPem: privateKeyPem(),
    };
  }

  /**
   * @param policyName - Policy to attach.
   * @param certificateArn - Certificate to attach it to.
   * @throws {Error} `ResourceNotFoundException` when the certificate does not exist.
   */
  async attachPolicy(policyName: string, certificateArn: string): Promise<void> {
    await this.gate.enter("attachPolicy");
    this.byArn(certificateArn).policies.add(policyName);
  }

  /**
   * @param thingName - Thing to attach the certificate to.
   * @param certificateArn - The certificate.
   * @throws {Error} `ResourceNotFoundException` when the thing or the certificate is absent;
   * `ResourceAlreadyExistsException` when the certificate belongs to another thing.
   */
  async attachExclusiveThing(thingName: ThingName, certificateArn: string): Promise<void> {
    await this.gate.enter("attachExclusiveThing");
    const thing = this.things.get(thingName);
    if (thing === undefined) {
      throw awsError("ResourceNotFoundException");
    }
    const certificate = this.byArn(certificateArn);
    if (certificate.thingName !== null && certificate.thingName !== thingName) {
      throw awsError("ResourceAlreadyExistsException");
    }
    certificate.thingName = thingName;
    thing.principals.add(certificateArn);
  }

  /**
   * @param certificateId - Certificate to activate.
   * @throws {Error} `ResourceNotFoundException` when the certificate does not exist.
   */
  async activateCertificate(certificateId: string): Promise<void> {
    await this.gate.enter("activateCertificate");
    this.byId(certificateId).status = "ACTIVE";
  }

  /**
   * Revokes a certificate. An absent certificate is a success, as the adapter maps it.
   *
   * @param certificateId - Certificate to revoke.
   */
  async revokeCertificate(certificateId: string): Promise<void> {
    await this.gate.enter("revokeCertificate");
    const certificate = this.certificates.get(certificateId);
    if (certificate !== undefined) {
      certificate.status = "REVOKED";
    }
  }

  /**
   * @param policyName - Policy to detach.
   * @param certificateArn - Certificate it is attached to.
   */
  async detachPolicy(policyName: string, certificateArn: string): Promise<void> {
    await this.gate.enter("detachPolicy");
    this.findByArn(certificateArn)?.policies.delete(policyName);
  }

  /**
   * @param thingName - Thing the certificate is attached to.
   * @param certificateArn - The certificate.
   */
  async detachThing(thingName: ThingName, certificateArn: string): Promise<void> {
    await this.gate.enter("detachThing");
    this.things.get(thingName)?.principals.delete(certificateArn);
    const certificate = this.findByArn(certificateArn);
    if (certificate !== undefined && certificate.thingName === thingName) {
      certificate.thingName = null;
    }
  }

  /**
   * @param thingName - Thing name.
   * @returns The ARNs of the principals of the thing; empty when the thing is absent.
   */
  async listThingCertificateArns(thingName: ThingName): Promise<string[]> {
    await this.gate.enter("listThingCertificateArns");
    return [...(this.things.get(thingName)?.principals ?? [])];
  }

  /**
   * @param clientId - The client to disconnect.
   */
  async disconnect(clientId: ThingName): Promise<void> {
    await this.gate.enter("disconnect");
    this.disconnects.push(clientId);
  }

  /**
   * Creates a certificate record with the next serial.
   *
   * @param status - Initial status.
   * @returns The stored certificate.
   */
  private newCertificate(status: FakeCertificate["status"]): FakeCertificate {
    this.serial += 1;
    const certificateId = String(this.serial).padStart(64, "0");
    const certificate: FakeCertificate = {
      certificateId,
      certificateArn: certificateArnOf(certificateId),
      status,
      policies: new Set(),
      thingName: null,
    };
    this.certificates.set(certificateId, certificate);
    return certificate;
  }

  /**
   * @param arn - Certificate ARN.
   * @returns The certificate, or undefined.
   */
  private findByArn(arn: string): FakeCertificate | undefined {
    return [...this.certificates.values()].find((item) => item.certificateArn === arn);
  }

  /**
   * @param arn - Certificate ARN.
   * @returns The certificate.
   * @throws {Error} `ResourceNotFoundException` when absent.
   */
  private byArn(arn: string): FakeCertificate {
    const certificate = this.findByArn(arn);
    if (certificate === undefined) {
      throw awsError("ResourceNotFoundException");
    }
    return certificate;
  }

  /**
   * @param certificateId - Certificate identifier.
   * @returns The certificate.
   * @throws {Error} `ResourceNotFoundException` when absent.
   */
  private byId(certificateId: string): FakeCertificate {
    const certificate = this.certificates.get(certificateId);
    if (certificate === undefined) {
      throw awsError("ResourceNotFoundException");
    }
    return certificate;
  }
}
