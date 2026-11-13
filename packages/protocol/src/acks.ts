/**
 * Acknowledgements: the robot's answer to every command it did not drop silently.
 *
 * A command the robot cannot trust (oversized, unparsable or without a `commandId`) gets no ack at
 * all: there is no trusted identity to answer. Every other command gets exactly one ack, `ACK` or
 * `REJECT` with a reason. `HEARTBEAT` is the exception and is never acknowledged, to keep traffic
 * at 4 Hz from doubling.
 */
import { z } from "zod";
import { RobotEnvelopeShape } from "./envelope";
import { CorrelationIdSchema } from "./ids";
import { RobotReportedStateSchema } from "./robot-state";
import { IsoMsSchema } from "./time";
import { Uuidv7Schema } from "./uuidv7";

/** Why a command was refused. Each value maps to one stage of the robot's command pipeline. */
export const AckReasonSchema = z.enum([
  "EXPIRED",
  "DUPLICATE",
  "INVALID_STATE",
  "NOT_LOCK_HOLDER",
  "INVALID",
  "NOT_SIMULATED",
]);

/** A validated refusal reason. */
export type AckReason = z.infer<typeof AckReasonSchema>;

/** Fields shared by both results of an acknowledgement. */
const AckBaseShape = {
  ...RobotEnvelopeShape,
  commandId: Uuidv7Schema,
  correlationId: CorrelationIdSchema,
  // The robot's own clock at the moment it decided, distinct from the envelope `ts` of the ack.
  robotTs: IsoMsSchema,
  state: RobotReportedStateSchema,
};

/**
 * Acknowledgement of one command, discriminated on `result`. A `REJECT` must name a reason and an
 * `ACK` must not: a reason on an accepted command would be a contradiction.
 */
export const AckSchema = z.discriminatedUnion("result", [
  z.strictObject({ ...AckBaseShape, result: z.literal("ACK") }),
  z.strictObject({ ...AckBaseShape, result: z.literal("REJECT"), reason: AckReasonSchema }),
]);

/** A validated acknowledgement. */
export type Ack = z.infer<typeof AckSchema>;
