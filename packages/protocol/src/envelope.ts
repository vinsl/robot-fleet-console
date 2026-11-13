/**
 * Envelopes: the fields every message carries, in each direction.
 *
 * Robot-to-cloud messages carry a sequence number and a boot identifier so that the cloud can order
 * them and detect a reboot. Cloud-to-robot commands do not: the cloud is stateless per command, so a
 * per-robot counter would need an atomic write for every command. Replay protection for commands
 * uses `commandId` and `issuedAt` instead.
 */
import { z } from "zod";
import { RobotIdSchema, SiteIdSchema } from "./ids";
import { IsoMsSchema } from "./time";
import { Uuidv7Schema } from "./uuidv7";

/**
 * Semantic version whose major is `SCHEMA_MAJOR` (see `constants.ts`). The literal is written out so
 * that the emitted JSON Schema carries the pattern verbatim; a test checks it against the constant.
 */
export const SchemaVersionSchema = z.string().regex(/^1\.\d+\.\d+$/);

/** Largest value a sequence number may take: the largest integer a JavaScript number holds exactly. */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/** Fields of a robot-to-cloud message. Spread into the object schema of each message kind. */
export const RobotEnvelopeShape = {
  schemaVersion: SchemaVersionSchema,
  messageId: Uuidv7Schema,
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
  ts: IsoMsSchema,
  seq: z.int().min(0).max(MAX_SEQ),
  bootId: Uuidv7Schema,
};

/** Object schema of the robot envelope, for consumers that only need the header. */
export const RobotEnvelopeSchema = z.strictObject(RobotEnvelopeShape);

/** Fields of a cloud-to-robot command. Spread into the command schema. */
export const CloudEnvelopeShape = {
  schemaVersion: SchemaVersionSchema,
  messageId: Uuidv7Schema,
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
  ts: IsoMsSchema,
};
