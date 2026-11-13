/**
 * Idempotent removal of the live identity of a robot: its certificates, its session, its policy and
 * attachments, and its video channel.
 *
 * The same operation serves retirement, the compensation of a failed registration and the cleanup that
 * precedes a new registration, so every step tolerates resources that are already gone.
 */
import { ROBOT_POLICY_NAME, type ThingName } from "@mfc/protocol";
import type { Deadline, RobotsDeps } from "../ports";
import { RobotsError } from "./problems";
import { CertificateRefSchema, type CertificateRef } from "./registry";

/**
 * Time a provisioning step needs to be worth starting. A step that begins with less than this left
 * cannot finish its SDK calls, and the function would stop half way with resources to clean up.
 */
export const MIN_STEP_BUDGET_MS = 8000;

/**
 * Refuses to start a step when the invocation has too little time left.
 *
 * @param deadline - The invocation deadline.
 * @throws {RobotsError} With code `provisioning-failed` when less than {@link MIN_STEP_BUDGET_MS} remains.
 */
export function assertStepBudget(deadline: Deadline): void {
  if (deadline.remainingMs() < MIN_STEP_BUDGET_MS) {
    throw new RobotsError("provisioning-failed");
  }
}

/** Dependencies of the teardown: the IoT and video adapters, and the logger for skipped principals. */
export type TeardownDeps = Pick<RobotsDeps, "iot" | "kvs" | "logger">;

/** What the teardown is asked to remove. */
export interface TeardownInput {
  /** Thing of the robot. */
  readonly thingName: ThingName;
  /** Certificates the registry knows about; the thing may also have others. */
  readonly knownCertificates: readonly CertificateRef[];
}

/** What the teardown removed. */
export interface TeardownReport {
  /** Number of certificates revoked, known or found attached to the thing. */
  readonly revoked: number;
  /** True when this call deleted the video channel. */
  readonly channelDeleted: boolean;
}

/** Validator of a certificate ARN, shared with the registry so that both use one grammar. */
const CERTIFICATE_ARN = CertificateRefSchema.shape.certificateArn;

/**
 * Removes every live resource of a robot. The order is part of the contract: certificates are revoked
 * first, so that no new connection or credential request can succeed; the session is then ended; the
 * policy and the attachments are detached; the channel is deleted last.
 *
 * Every call is idempotent, so a teardown can be repeated after a partial failure. Any other error
 * propagates, and the caller decides what the failure means.
 *
 * @param deps - IoT, video, and logger.
 * @param input - The thing and the certificates the registry knows about.
 * @returns How many certificates were revoked and whether the channel was deleted.
 */
export async function teardownRobotResources(
  deps: TeardownDeps,
  input: TeardownInput,
): Promise<TeardownReport> {
  const { iot, kvs, logger } = deps;
  const { thingName, knownCertificates } = input;

  const listed = await iot.listThingCertificateArns(thingName);
  // ARN to certificate identifier, in first-seen order: a certificate known to the registry and also
  // attached to the thing is removed once.
  const certificates = new Map<string, string>();
  for (const arn of [...knownCertificates.map((known) => known.certificateArn), ...listed]) {
    if (certificates.has(arn)) {
      continue;
    }
    const certificateId = certificateIdOf(arn);
    if (certificateId === undefined) {
      // A principal that is not a robot certificate is not ours to revoke. Its ARN is not logged: it
      // carries the account identifier.
      logger.warn("non-certificate principal skipped");
      continue;
    }
    certificates.set(arn, certificateId);
  }

  for (const certificateId of certificates.values()) {
    await iot.revokeCertificate(certificateId);
  }
  await iot.disconnect(thingName);
  for (const certificateArn of certificates.keys()) {
    await iot.detachPolicy(ROBOT_POLICY_NAME, certificateArn);
    await iot.detachThing(thingName, certificateArn);
  }
  const channel = await kvs.deleteChannel(thingName);

  return { revoked: certificates.size, channelDeleted: channel === "deleted" };
}

/**
 * Extracts the certificate identifier from a certificate ARN.
 *
 * @param arn - A candidate ARN, from the registry or from the IoT listing.
 * @returns The identifier, or undefined when the ARN is not a certificate ARN of the demo regions.
 */
function certificateIdOf(arn: string): string | undefined {
  if (!CERTIFICATE_ARN.safeParse(arn).success) {
    return undefined;
  }
  return /cert\/([a-f0-9]{64})$/.exec(arn)?.[1];
}
