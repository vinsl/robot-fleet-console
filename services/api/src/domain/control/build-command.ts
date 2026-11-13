/**
 * Builds the cloud envelope of a command the cloud publishes to a robot.
 *
 * The builder is the one place that assembles a command, so the contract with the robot (ADR 0027) is tested once:
 * every type the console can send, and the lock types, must pass the protocol's `CommandSchema`. The time of the
 * command is the cloud clock at publish, never a value from the client (D6).
 */
import {
  CommandSchema,
  SCHEMA_VERSION,
  type Command,
  type CommandType,
  type CorrelationId,
  type LockToken,
  type RobotId,
  type SiteId,
  type UserSub,
  type Uuidv7,
} from "@mfc/protocol";

/** Facts of one command, as the use case knows them before it is published. */
export interface BuildCommandInput {
  /** Command type. */
  readonly type: CommandType;
  /** Robot the command is for. */
  readonly robotId: RobotId;
  /** Site of the robot. */
  readonly siteId: SiteId;
  /** Identifier the client minted for the request. */
  readonly commandId: Uuidv7;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
  /** Identifier of this message on the topic. */
  readonly messageId: Uuidv7;
  /** Subject of the verified caller, who the robot checks against the lock token. */
  readonly issuedBy: UserSub;
  /** Cloud clock at publish. Becomes both `ts` and `issuedAt`. */
  readonly now: Date;
  /** Lock token, required by `TAKE_CONTROL` and by the lock-required commands. */
  readonly lockToken?: LockToken | undefined;
  /** Parameters of the command, required by `SIMULATE_FAULT`; empty otherwise. */
  readonly params?: unknown;
}

/**
 * Builds and validates one command.
 *
 * @param input - The facts of the command.
 * @returns The command, validated by the protocol schema.
 * @throws {ZodError} When the input does not form a valid command. The callers build from validated input, so this
 * is a programming error and not a client error.
 */
export function buildCommand(input: BuildCommandInput): Command {
  const issuedAt = input.now.toISOString();
  return CommandSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    messageId: input.messageId,
    robotId: input.robotId,
    siteId: input.siteId,
    ts: issuedAt,
    commandId: input.commandId,
    issuedAt,
    issuedBy: input.issuedBy,
    correlationId: input.correlationId,
    ...(input.lockToken === undefined ? {} : { lockToken: input.lockToken }),
    type: input.type,
    params: input.params ?? {},
  });
}
