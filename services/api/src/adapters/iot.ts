/**
 * IoT Core and the IoT data plane, over the AWS SDK.
 *
 * Certificate creation uses a client with no retry: a retried `CreateKeysAndCertificate` would mint a
 * second key pair, and only one of them could reach the robot. Every other call uses the standard client.
 * The mapping of error codes to outcomes is the contract of {@link IotPort}: a call whose target is
 * already in the wanted state succeeds, so that a teardown can be repeated.
 */
import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateKeysAndCertificateCommand,
  CreateThingCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  ListThingPrincipalsCommand,
  UpdateCertificateCommand,
  type IoTClient,
} from "@aws-sdk/client-iot";
import { DeleteConnectionCommand, type IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import type { RobotId, SiteId, ThingName } from "@mfc/protocol";
import type { CreatedCertificate, IotPort } from "../domain/ports";
import { RobotsError } from "../domain/robots/problems";
import { CertificateRefSchema } from "../domain/robots/registry";
import { isAwsError } from "./aws-errors";

/** Principals requested per page of `ListThingPrincipals`, the service maximum for this call. */
const PRINCIPAL_PAGE_SIZE = 25;

/**
 * Upper bound on the pages read for one thing. A robot has at most a handful of certificates, so a
 * longer listing means something attached the thing that this code did not create. The teardown then
 * fails, instead of silently leaving an unlisted certificate active.
 */
const MAX_PRINCIPAL_PAGES = 4;

/** Validator of a certificate ARN of the demo regions, shared with the registry. */
const CERTIFICATE_ARN = CertificateRefSchema.shape.certificateArn;

/** The three SDK clients the IoT adapter uses. Each one is configured by the function, not here. */
export interface IotClients {
  /** Standard IoT control-plane client. */
  readonly iot: Pick<IoTClient, "send">;
  /** IoT control-plane client with a single attempt, used only for certificate creation. */
  readonly iotNoRetry: Pick<IoTClient, "send">;
  /** IoT data-plane client, used to end a live session. */
  readonly iotData: Pick<IoTDataPlaneClient, "send">;
}

/** IoT Core over the AWS SDK. */
export class AwsIot implements IotPort {
  /** @param clients - The SDK clients, one per retry policy. */
  constructor(private readonly clients: IotClients) {}

  /**
   * Creates the thing. Re-creating a thing with the same attributes succeeds; different attributes are a
   * conflict, reported as a provisioning failure.
   *
   * @param thingName - Thing name of the robot.
   * @param attributes - The attributes the IoT policy binds topics to.
   * @throws {RobotsError} With code `provisioning-failed` when the thing exists with other attributes.
   */
  async createThing(
    thingName: ThingName,
    attributes: { robotId: RobotId; siteId: SiteId },
  ): Promise<void> {
    try {
      await this.clients.iot.send(
        new CreateThingCommand({
          thingName,
          attributePayload: {
            attributes: { robotId: attributes.robotId, siteId: attributes.siteId },
            merge: false,
          },
        }),
      );
    } catch (error) {
      if (isAwsError(error, "ResourceAlreadyExistsException")) {
        throw new RobotsError("provisioning-failed");
      }
      throw error;
    }
  }

  /**
   * Creates a certificate and its key pair, in the `INACTIVE` state. The key is returned once and held
   * only by the caller.
   *
   * @returns The certificate identifiers, its PEM and the private key PEM.
   * @throws {RobotsError} With code `provisioning-failed` when the response lacks a field, or its
   * identifiers are not in the registry grammar.
   */
  async createInactiveCertificate(): Promise<CreatedCertificate> {
    const output = await this.clients.iotNoRetry.send(
      new CreateKeysAndCertificateCommand({ setAsActive: false }),
    );
    const reference = CertificateRefSchema.safeParse({
      certificateId: output.certificateId,
      certificateArn: output.certificateArn,
    });
    const certificatePem = output.certificatePem;
    const privateKeyPem = output.keyPair?.PrivateKey;
    if (!reference.success || certificatePem === undefined || privateKeyPem === undefined) {
      // The message names no field value: the response carries key material.
      throw new RobotsError("provisioning-failed");
    }
    return {
      certificateId: reference.data.certificateId,
      certificateArn: reference.data.certificateArn,
      certificatePem,
      privateKeyPem,
    };
  }

  /**
   * Attaches the robot policy to a certificate.
   *
   * @param policyName - Name of the policy.
   * @param certificateArn - ARN of the certificate.
   */
  async attachPolicy(policyName: string, certificateArn: string): Promise<void> {
    await this.clients.iot.send(new AttachPolicyCommand({ policyName, target: certificateArn }));
  }

  /**
   * Attaches a certificate to a thing as its exclusive principal, so that no other certificate can
   * authenticate as the robot.
   *
   * @param thingName - The thing.
   * @param certificateArn - The certificate.
   */
  async attachExclusiveThing(thingName: ThingName, certificateArn: string): Promise<void> {
    await this.clients.iot.send(
      new AttachThingPrincipalCommand({
        thingName,
        principal: certificateArn,
        thingPrincipalType: "EXCLUSIVE_THING",
      }),
    );
  }

  /**
   * Moves a certificate to `ACTIVE`. Activation is the last IoT step of a registration, so every failure
   * here is a failure of the registration.
   *
   * @param certificateId - Identifier of the certificate.
   */
  async activateCertificate(certificateId: string): Promise<void> {
    await this.clients.iot.send(
      new UpdateCertificateCommand({ certificateId, newStatus: "ACTIVE" }),
    );
  }

  /**
   * Moves a certificate to `REVOKED`. A certificate already revoked is reported as a state conflict, and
   * an absent certificate as not found: both mean the goal is met. Any other invalid request (such as a
   * malformed identifier) is a bug of the caller, not a met goal, so it propagates.
   *
   * @param certificateId - Identifier of the certificate.
   */
  async revokeCertificate(certificateId: string): Promise<void> {
    try {
      await this.clients.iot.send(
        new UpdateCertificateCommand({ certificateId, newStatus: "REVOKED" }),
      );
    } catch (error) {
      if (!isAwsError(error, "CertificateStateException", "ResourceNotFoundException")) {
        throw error;
      }
    }
  }

  /**
   * Detaches the robot policy from a certificate. An absent attachment is success.
   *
   * @param policyName - Name of the policy.
   * @param certificateArn - ARN of the certificate.
   */
  async detachPolicy(policyName: string, certificateArn: string): Promise<void> {
    try {
      await this.clients.iot.send(new DetachPolicyCommand({ policyName, target: certificateArn }));
    } catch (error) {
      if (!isAwsError(error, "ResourceNotFoundException")) {
        throw error;
      }
    }
  }

  /**
   * Detaches a certificate from a thing. An absent attachment is success.
   *
   * @param thingName - The thing.
   * @param certificateArn - The certificate.
   */
  async detachThing(thingName: ThingName, certificateArn: string): Promise<void> {
    try {
      await this.clients.iot.send(
        new DetachThingPrincipalCommand({ thingName, principal: certificateArn }),
      );
    } catch (error) {
      if (!isAwsError(error, "ResourceNotFoundException")) {
        throw error;
      }
    }
  }

  /**
   * Lists the certificates attached to a thing, reading at most {@link MAX_PRINCIPAL_PAGES} pages.
   * Principals that are not certificates of the demo regions are not returned.
   *
   * @param thingName - The thing.
   * @returns The certificate ARNs; empty when the thing does not exist.
   * @throws {RobotsError} With code `internal` when the listing has more pages than the bound.
   */
  async listThingCertificateArns(thingName: ThingName): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PRINCIPAL_PAGES; page += 1) {
      let output;
      try {
        output = await this.clients.iot.send(
          new ListThingPrincipalsCommand({
            thingName,
            maxResults: PRINCIPAL_PAGE_SIZE,
            nextToken,
          }),
        );
      } catch (error) {
        if (isAwsError(error, "ResourceNotFoundException")) {
          return [];
        }
        throw error;
      }
      for (const principal of output.principals ?? []) {
        if (CERTIFICATE_ARN.safeParse(principal).success) {
          arns.push(principal);
        }
      }
      if (output.nextToken === undefined) {
        return arns;
      }
      nextToken = output.nextToken;
    }
    throw new RobotsError("internal");
  }

  /**
   * Ends the live session of a client, without its last will and without keeping its session state, so
   * that the robot cannot resume with the revoked credentials.
   *
   * @param clientId - The client identifier, the thing name.
   */
  async disconnect(clientId: ThingName): Promise<void> {
    try {
      await this.clients.iotData.send(
        new DeleteConnectionCommand({
          clientId,
          cleanSession: true,
          preventWillMessage: true,
        }),
      );
    } catch (error) {
      if (!isAwsError(error, "ResourceNotFoundException")) {
        throw error;
      }
    }
  }
}
