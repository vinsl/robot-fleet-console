/**
 * Registry record of a robot and the pure rules that govern its lifecycle.
 *
 * The record is the cloud's view of a robot: identity, status, the certificates recorded for it and the
 * version used for optimistic concurrency. Nothing here touches AWS; the registry adapter stores it.
 */
import {
  CorrelationIdSchema,
  IsoMsSchema,
  KvsChannelArnSchema,
  RobotSummarySchema,
  ThingNameSchema,
  type RobotSummary,
} from "@mfc/protocol";
import { z } from "zod";

/** Steps of a registration or retirement, recorded as `failedStep` when one of them fails. */
export const ProvisioningStepSchema = z.enum([
  "RESERVE",
  "CLEANUP",
  "THING",
  "CERTIFICATE",
  "RECORD_CERTIFICATE",
  "POLICY",
  "THING_PRINCIPAL",
  "CHANNEL",
  "ACTIVATE",
  "KIT",
  "COMMIT",
]);

/** A validated provisioning step. */
export type ProvisioningStep = z.infer<typeof ProvisioningStepSchema>;

/**
 * A certificate the cloud created for a robot. Only identifiers are stored: the private key is never kept.
 * The ARN is region-bound to the two demo regions, so a foreign ARN cannot be recorded.
 */
export const CertificateRefSchema = z.strictObject({
  certificateId: z.string().regex(/^[a-f0-9]{64}$/),
  certificateArn: z
    .string()
    .regex(/^arn:aws:iot:(?:eu-west-3|eu-west-1):\d{12}:cert\/[a-f0-9]{64}$/),
});

/** A validated certificate reference. */
export type CertificateRef = z.infer<typeof CertificateRefSchema>;

/**
 * Upper bound on the certificates recorded for one robot id. Each failed registration leaves its
 * certificate revoked, so the bound caps how many attempts one id can absorb before an operator retires it.
 */
export const MAX_CERTIFICATES_PER_ROBOT = 10;

/**
 * Age after which a `PROVISIONING` record is presumed abandoned by a crashed invocation. A live
 * registration writes its record at every step, and a step is bounded by the SDK timeouts, so 120 s is
 * far above the time a healthy registration can stay silent.
 */
export const PROVISIONING_STALE_MS = 120_000;

/**
 * Registry entry of a robot. Strict and extended from the API summary, so the stored record carries the
 * summary fields plus the provisioning state, and nothing else.
 */
export const RobotRecordSchema = RobotSummarySchema.extend({
  thingName: ThingNameSchema,
  version: z.int().min(1),
  updatedAt: IsoMsSchema,
  certificates: z.array(CertificateRefSchema).max(MAX_CERTIFICATES_PER_ROBOT),
  kvsChannelArn: KvsChannelArnSchema.optional(),
  lastCorrelationId: CorrelationIdSchema,
  failedStep: ProvisioningStepSchema.optional(),
});

/** A validated registry record. */
export type RobotRecord = z.infer<typeof RobotRecordSchema>;

/**
 * Tells whether a `PROVISIONING` record has been silent for longer than {@link PROVISIONING_STALE_MS}.
 *
 * The age is measured from `updatedAt`, the last write of the record, not from its creation: a retried
 * registration that keeps making progress is never presumed dead.
 *
 * @param record - The registry record.
 * @param now - The current instant.
 * @returns True when the silence is strictly longer than the stale threshold.
 */
export function isStaleProvisioning(record: RobotRecord, now: Date): boolean {
  return now.getTime() - Date.parse(record.updatedAt) > PROVISIONING_STALE_MS;
}

/**
 * Tells whether a registration may take over an existing record for the same robot id.
 *
 * A failed registration can be resumed, and so can a crashed one once it is stale. A live one cannot,
 * and an active, retiring or retired robot never can.
 *
 * @param record - The existing registry record.
 * @param now - The current instant.
 * @returns True for `PROVISIONING_FAILED`, and for `PROVISIONING` when stale.
 */
export function canResumeRegistration(record: RobotRecord, now: Date): boolean {
  if (record.status === "PROVISIONING_FAILED") {
    return true;
  }
  return record.status === "PROVISIONING" && isStaleProvisioning(record, now);
}

/** Outcome of the retirement rule for an existing record. */
export type RetireDecision = "retire" | "already-retired" | "conflict";

/**
 * Decides whether a retirement may proceed on an existing record.
 *
 * A retired robot answers as an idempotent repeat. A fresh registration is still in flight, so the
 * retirement must wait for it. Every other status can be retired, and a retirement that failed half way
 * resumes from `RETIRING`.
 *
 * @param record - The existing registry record.
 * @param now - The current instant.
 * @returns `retire` to proceed, `already-retired` for a repeat, `conflict` while a live registration runs.
 */
export function canRetire(record: RobotRecord, now: Date): RetireDecision {
  switch (record.status) {
    case "RETIRED":
      return "already-retired";
    case "PROVISIONING":
      return isStaleProvisioning(record, now) ? "retire" : "conflict";
    case "ACTIVE":
    case "PROVISIONING_FAILED":
    case "RETIRING":
      return "retire";
  }
}

/**
 * Projects a registry record onto the public summary. Only the summary fields leave the domain, so the
 * certificates, the channel and the provisioning state never reach a response.
 *
 * @param record - The registry record.
 * @returns The summary, with `retiredAt` present only when the robot is retired.
 */
export function toSummary(record: RobotRecord): RobotSummary {
  return {
    robotId: record.robotId,
    siteId: record.siteId,
    name: record.name,
    type: record.type,
    designDate: record.designDate,
    simulated: record.simulated,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.retiredAt === undefined ? {} : { retiredAt: record.retiredAt }),
  };
}
