/**
 * Builds the kit a robot installs once: its certificate and key, the root CA, and the non-secret config.
 *
 * The kit is the only copy of the private key. It is validated against the shared schema before it leaves
 * the domain, so a malformed key is refused here and never reaches the caller.
 */
import { ROLE_ALIAS_NAME, RobotKitSchema, type RobotKit } from "@mfc/protocol";
import { AMAZON_ROOT_CA_1_PEM } from "./amazon-root-ca";
import type { CreatedCertificate, RobotsConfig } from "../ports";
import { RobotsError } from "./problems";
import type { RobotRecord } from "./registry";

/** Inputs of a kit: the robot, the certificate just issued, its channel and the function configuration. */
export interface KitInput {
  /** The robot the kit belongs to. */
  readonly record: Pick<RobotRecord, "robotId" | "siteId" | "thingName" | "simulated">;
  /** The certificate issued for the robot. */
  readonly cert: CreatedCertificate;
  /** ARN of the video channel created for the robot. */
  readonly channelArn: string;
  /** Function configuration: region and endpoints. */
  readonly config: RobotsConfig;
}

/**
 * Builds and validates a kit.
 *
 * Line endings are normalised to LF before validation, because the key may come from a source that writes
 * CRLF. The error thrown on refusal carries no part of the input: the key must not reach a log.
 *
 * @param input - The robot, its certificate, its channel and the configuration.
 * @returns The validated kit.
 * @throws {RobotsError} With code `provisioning-failed` when the assembled kit does not match the schema.
 */
export function buildKit(input: KitInput): RobotKit {
  const { record, cert, channelArn, config } = input;
  const parsed = RobotKitSchema.safeParse({
    certificatePem: withUnixNewlines(cert.certificatePem),
    privateKeyPem: withUnixNewlines(cert.privateKeyPem),
    rootCaPem: AMAZON_ROOT_CA_1_PEM,
    config: {
      robotId: record.robotId,
      siteId: record.siteId,
      thingName: record.thingName,
      simulated: record.simulated,
      region: config.region,
      iotEndpoint: config.iotEndpoint,
      credentialsEndpoint: config.credentialsEndpoint,
      roleAlias: ROLE_ALIAS_NAME,
      // The channel is named after the thing, so the credentials policy binds it to one robot.
      kvsChannelName: record.thingName,
      kvsChannelArn: channelArn,
    },
  });
  if (!parsed.success) {
    throw new RobotsError("provisioning-failed");
  }
  return parsed.data;
}

/**
 * Replaces CRLF line endings by LF.
 *
 * @param pem - A PEM text.
 * @returns The same text with LF line endings.
 */
function withUnixNewlines(pem: string): string {
  return pem.replace(/\r\n/g, "\n");
}
