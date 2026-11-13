/**
 * Ports of the control use cases: the robot lock, the command claims, the demo flag, the robot registry read, the
 * command publisher, the relay of the lock changes, the audit trail, and the dependencies they share.
 *
 * The ports state the outcome the domain needs rather than the SDK call behind it: `acquire` says whether the lock
 * was taken, refreshed or held, not which condition failed. The domain therefore never imports an SDK, and each
 * adapter is tested against the same contract as the in-memory fakes.
 */
import type {
  AuditRecord,
  CommandType,
  CorrelationId,
  DemoState,
  IsoMs,
  LockToken,
  RobotId,
  SiteId,
  UserSub,
  Uuidv7,
} from "@mfc/protocol";
import { LockChangeCauseSchema } from "@mfc/protocol";
import type { z } from "zod";
import type { RobotRecord } from "../robots/registry";
import type { Clock, DomainLogger, Ids } from "../ports";

/** Cause of a lock change, as the protocol names it on the `lock.changed` frame. */
export type LockChangeCause = z.infer<typeof LockChangeCauseSchema>;

/**
 * The robot lock as stored in the fleet table. The token is the cloud's secret: it is injected into the commands
 * the cloud publishes and never leaves the cloud (ADR 0062).
 */
export interface LockItem {
  /** Robot the lock belongs to. */
  readonly robotId: RobotId;
  /** Subject of the holder. */
  readonly holder: UserSub;
  /** Token the robot compares with the holder subject. Never returned, never logged. */
  readonly token: LockToken;
  /** Instant the holder acquired the lock. */
  readonly acquiredAt: IsoMs;
  /** Expiry, in epoch seconds: the last holder activity plus the idle expiry. */
  readonly expiresAt: number;
}

/** Outcome of an acquire: taken, refreshed because the caller already held it, or held by another live holder. */
export type LockAcquireOutcome = "ACQUIRED" | "REFRESHED" | "HELD";

/** Store of the robot locks. */
export interface LockStorePort {
  /**
   * Strongly consistent read of the lock item of a robot. The item may be expired: the caller decides.
   *
   * @returns The item, or null when none was ever written or the table has deleted it.
   */
  get(siteId: SiteId, robotId: RobotId): Promise<LockItem | null>;

  /**
   * Writes the lock when it is free, expired, or already held by the same subject. The condition is evaluated by
   * the store, so two concurrent acquires cannot both succeed.
   *
   * @param next - The lock to write.
   * @param nowSeconds - The current instant in epoch seconds, used by the condition.
   * @returns `ACQUIRED` when the lock was free or expired, `REFRESHED` when the caller already held it, `HELD`
   * when another live holder keeps it.
   */
  acquire(siteId: SiteId, next: LockItem, nowSeconds: number): Promise<LockAcquireOutcome>;

  /**
   * Moves the expiry of a lock the caller holds, when the stored holder and token still match and the lock is live.
   *
   * @returns `true` when the item was refreshed, `false` when the condition no longer holds.
   */
  refresh(
    siteId: SiteId,
    robotId: RobotId,
    holder: UserSub,
    token: LockToken,
    expiresAtSeconds: number,
    nowSeconds: number,
  ): Promise<boolean>;

  /**
   * Deletes the lock when the stored holder and token still match the caller.
   *
   * @returns `true` when the item was deleted, `false` when the condition no longer holds.
   */
  release(siteId: SiteId, robotId: RobotId, holder: UserSub, token: LockToken): Promise<boolean>;
}

/** A command or a lock request as the claim records it, so a replay can be compared with the first request. */
export interface CommandClaim {
  /** Identifier the client minted for the request. */
  readonly commandId: Uuidv7;
  /** Robot the request named. */
  readonly robotId: RobotId;
  /** Command type the request named. Lock requests use `TAKE_CONTROL` and `RELEASE_CONTROL`. */
  readonly type: CommandType;
  /** Subject that made the first request. */
  readonly actor: UserSub;
  /** Correlation identifier the first request got. */
  readonly correlationId: CorrelationId;
  /** Instant the first request was accepted. */
  readonly issuedAt: IsoMs;
}

/** Outcome of a claim: the identifier was free and is now claimed, or it was claimed before. */
export type CommandClaimOutcome =
  { readonly kind: "CLAIMED" } | { readonly kind: "EXISTS"; readonly claim: CommandClaim };

/** Idempotency claims of the commands and lock requests, keyed by the client identifier. */
export interface CommandClaimPort {
  /**
   * Claims an identifier, once. The conditional write is what makes a replay publish nothing twice.
   *
   * @param claim - The request to claim.
   * @param expiresAtSeconds - Retention of the claim, in epoch seconds.
   */
  claim(
    siteId: SiteId,
    claim: CommandClaim,
    expiresAtSeconds: number,
  ): Promise<CommandClaimOutcome>;

  /** Removes a claim after its request failed before any effect, so the same identifier can be sent again. */
  abandon(siteId: SiteId, commandId: Uuidv7): Promise<void>;
}

/** Store of the demo flag of a site. */
export interface DemoStorePort {
  /** Reads the flag. An absent item reads as disabled. */
  get(siteId: SiteId): Promise<DemoState>;

  /**
   * Stores the flag.
   *
   * @returns The state as stored.
   */
  set(siteId: SiteId, next: DemoState): Promise<DemoState>;
}

/** Read access to the robot registry, as the control use cases need it. */
export interface RobotReadPort {
  /**
   * Strongly consistent read of one robot of a site.
   *
   * @returns The record, or null when the site has no robot with this id.
   */
  get(siteId: SiteId, robotId: RobotId): Promise<RobotRecord | null>;

  /** Every robot record of a site, bounded by the store. */
  list(siteId: SiteId): Promise<RobotRecord[]>;
}

/** Publishes one command on the IoT data plane. */
export interface CommandPublisherPort {
  /**
   * Publishes one payload, once, at QoS 1.
   *
   * @param topic - The command topic of the robot.
   * @param payload - The serialised command.
   * @throws When the publish fails or the payload is refused. The caller answers `upstream-failed`.
   */
  publish(topic: string, payload: string): Promise<void>;
}

/** Sends the `lock.changed` frames of the lock changes. Never throws. */
export interface ControlRelayPort {
  /**
   * Sends the change to every connected console of the site.
   *
   * @param siteId - Site of the robot.
   * @param robotId - Robot whose lock changed.
   * @param held - Whether the lock is held after the change.
   * @param holder - Subject of the holder, absent when the lock is free.
   * @param cause - What caused the change.
   */
  lockChanged(
    siteId: SiteId,
    robotId: RobotId,
    held: boolean,
    holder: UserSub | undefined,
    cause: LockChangeCause,
  ): Promise<void>;
}

/** Audit trail of the control actions. A write rejects when it fails; the caller decides what a lost record means. */
export interface AuditPort {
  /** Appends one audit record. */
  write(record: AuditRecord): Promise<void>;
}

/** Names of the business metrics of the control use cases. */
export type ControlMetricName =
  | "CommandSent"
  | "CommandRefused"
  | "CommandDeduplicated"
  | "CommandPublishFailed"
  | "LockAcquired"
  | "LockRefused"
  | "LockReleased"
  | "AuditWriteFailed"
  | "DemoToggled"
  | "FaultInjected";

/** Business metrics sink of the control use cases. */
export interface ControlMetrics {
  /** Adds one to the named counter. */
  count(name: ControlMetricName): void;
}

/** Source of random bytes, injected so that the lock tokens are deterministic in tests. */
export type RandomBytes = (size: number) => Uint8Array;

/** The verified caller of a control request, and the correlation identifier and time left of the invocation. */
export interface ControlCall {
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
  /** Milliseconds left before the function is stopped. Read when the use case needs it, not earlier. */
  remainingMs(): number;
}

/** Dependencies of the control use cases. */
export interface ControlDeps {
  /** Lock store. */
  readonly locks: LockStorePort;
  /** Idempotency claims. */
  readonly claims: CommandClaimPort;
  /** Demo flag. */
  readonly demo: DemoStorePort;
  /** Robot registry read. */
  readonly robots: RobotReadPort;
  /** Command publisher. */
  readonly publisher: CommandPublisherPort;
  /** Relay of the lock changes. */
  readonly relay: ControlRelayPort;
  /** Audit trail. */
  readonly audit: AuditPort;
  /** Source of the current instant. */
  readonly clock: Clock;
  /** Source of identifiers. */
  readonly ids: Ids;
  /** Source of random bytes for the lock tokens. */
  readonly randomBytes: RandomBytes;
  /** Structured logger. Attributes never carry a token, a payload or an e-mail address. */
  readonly logger: DomainLogger;
  /** Business metrics sink. */
  readonly metrics: ControlMetrics;
}
