/**
 * Ports of the robot use cases: the interfaces the domain depends on.
 *
 * The adapters implement them over the AWS SDK, the tests over in-memory fakes. Each port states the
 * outcome the domain needs rather than the SDK call behind it: `reserve` says whether the id was free,
 * not which condition failed. The domain therefore never imports an SDK.
 */
import type {
  Actor,
  AuditRecord,
  AwsRegion,
  CorrelationId,
  RobotId,
  SiteId,
  ThingName,
  Uuidv7,
} from "@mfc/protocol";
import type { ResourceTags } from "../config/env";
import type { RobotRecord } from "./robots/registry";

/** Source of the current instant. Injected so that timestamps are deterministic in tests. */
export interface Clock {
  /** The current instant. */
  now(): Date;
}

/** Source of identifiers. Injected so that tests can follow the identifiers of a run. */
export interface Ids {
  /** A new time-ordered identifier. */
  uuidv7(): Uuidv7;
}

/** Remaining time of the invocation, so that a use case can stop before the function times out. */
export interface Deadline {
  /** Milliseconds left before the function is stopped. */
  remainingMs(): number;
}

/** Structured logger of the domain. Attributes must never carry a token, a key or personal data. */
export interface DomainLogger {
  /** Debug-level entry. */
  debug(message: string, attributes?: object): void;
  /** Info-level entry. */
  info(message: string, attributes?: object): void;
  /** Warning-level entry. */
  warn(message: string, attributes?: object): void;
  /** Error-level entry. */
  error(message: string, attributes?: object): void;
}

/** Names of the business metrics of the robot use cases. */
export type RobotsMetricName =
  | "RobotRegistered"
  | "RobotRegistrationRefused"
  | "RobotRegistrationFailed"
  | "RobotRetired"
  | "RobotRetirementFailed"
  | "CompensationFailed"
  | "AuditWriteFailed"
  | "LeftoverResourcesRemoved";

/** Business metrics sink. */
export interface DomainMetrics {
  /** Adds one to the named counter. */
  count(name: RobotsMetricName): void;
}

/** Outcome of a claim of a robot id: free, or already taken by a claim or a robot item. */
export type ReserveOutcome = "reserved" | "taken";

/** Outcome of a conditional replace: stored, or refused because the stored version moved on. */
export type ReplaceOutcome = "ok" | "conflict";

/** Registry of robots: the claim of each id and the record of each robot. */
export interface RegistryPort {
  /**
   * Claims the robot id and creates the robot record, atomically. `taken` if either already exists.
   *
   * @param record - The record to create, at version 1.
   * @param clientRequestToken - Idempotency token: an SDK retry of the same request reuses it.
   */
  reserve(record: RobotRecord, clientRequestToken: string): Promise<ReserveOutcome>;

  /**
   * Strongly consistent read of one robot of a site.
   *
   * @returns The record, or null when the site has no robot with this id.
   * @throws {RobotsError} With code `internal` when the stored item does not match the record schema.
   */
  get(siteId: SiteId, robotId: RobotId): Promise<RobotRecord | null>;

  /**
   * Conditional replace of a record: succeeds only when the stored version equals `expectedVersion`.
   * `next.version` must be `expectedVersion + 1`. When the write is refused, the adapter re-reads the
   * record: if the stored record equals `next` (an SDK retry of our own write) the outcome is `ok`.
   * Optional fields absent from `next` are compared as absent.
   *
   * @param expectedVersion - The version the caller read.
   * @param next - The record to store.
   */
  replace(expectedVersion: number, next: RobotRecord): Promise<ReplaceOutcome>;
}

/** Audit trail of admin actions. */
export interface AuditPort {
  /** Appends one audit record. Rejects when the write fails. */
  write(record: AuditRecord): Promise<void>;
}

/** A certificate created for a robot, with its key material. The key exists only in memory. */
export interface CreatedCertificate {
  /** Certificate identifier, 64 lowercase hexadecimal characters. */
  readonly certificateId: string;
  /** Certificate ARN. */
  readonly certificateArn: string;
  /** PEM of the certificate, handed to the robot in the kit. */
  readonly certificatePem: string;
  /** PEM of the private key, handed to the robot in the kit and never stored. */
  readonly privateKeyPem: string;
}

/** IoT Core and the IoT data plane, reduced to the operations the robot use cases need. */
export interface IotPort {
  /**
   * Creates the thing with its two attributes. Idempotent for identical attributes.
   *
   * @param thingName - Thing name of the robot.
   * @param attributes - Attributes the IoT policy binds topics to.
   */
  createThing(
    thingName: ThingName,
    attributes: { robotId: RobotId; siteId: SiteId },
  ): Promise<void>;

  /** Creates a certificate in the `INACTIVE` state: it cannot authenticate until activated. */
  createInactiveCertificate(): Promise<CreatedCertificate>;

  /** Attaches the robot policy to a certificate. */
  attachPolicy(policyName: string, certificateArn: string): Promise<void>;

  /** Attaches a certificate to a thing as its only principal. */
  attachExclusiveThing(thingName: ThingName, certificateArn: string): Promise<void>;

  /** Moves a certificate to the `ACTIVE` state. */
  activateCertificate(certificateId: string): Promise<void>;

  /** Moves a certificate to `REVOKED`. Succeeds when it is already revoked or absent. */
  revokeCertificate(certificateId: string): Promise<void>;

  /** Detaches a policy from a certificate. Succeeds when the attachment is absent. */
  detachPolicy(policyName: string, certificateArn: string): Promise<void>;

  /** Detaches a certificate from a thing. Succeeds when the attachment is absent. */
  detachThing(thingName: ThingName, certificateArn: string): Promise<void>;

  /**
   * Certificate ARNs attached to a thing, one per principal. Returns an empty list when the thing is
   * absent. Principals that are not certificates are not returned.
   */
  listThingCertificateArns(thingName: ThingName): Promise<string[]>;

  /** Disconnects the live session of a client, if any. Succeeds when there is none. */
  disconnect(clientId: ThingName): Promise<void>;
}

/** Video channels of the robots, one per thing. */
export interface KvsPort {
  /**
   * Creates the single-master signaling channel named after the thing, with a 60 s message TTL.
   * When it already exists and is active or being created, returns its ARN. When it is being deleted
   * or updated, throws `RobotsError("provisioning-failed")`: the caller retries after the deletion.
   *
   * @param name - Channel name, the thing name.
   * @param tags - Tags of the resource.
   */
  createChannel(name: ThingName, tags: ResourceTags): Promise<{ channelArn: string }>;

  /**
   * Deletes the channel named after the thing.
   *
   * @returns `deleted` when this call removed it, `absent` when it does not exist or is being deleted.
   */
  deleteChannel(name: ThingName): Promise<"deleted" | "absent">;
}

/** Configuration of the robots function, read from its environment and fixed for the invocation. */
export interface RobotsConfig {
  /** Region of the stack. */
  readonly region: AwsRegion;
  /** IoT data-plane endpoint the robot connects to. */
  readonly iotEndpoint: string;
  /** IoT credentials-provider endpoint the robot exchanges its certificate with. */
  readonly credentialsEndpoint: string;
  /** Tags written on every resource the function creates. */
  readonly resourceTags: ResourceTags;
}

/** Everything the robot use cases depend on. */
export interface RobotsDeps {
  /** Robot registry. */
  readonly registry: RegistryPort;
  /** IoT Core. */
  readonly iot: IotPort;
  /** Video channels. */
  readonly kvs: KvsPort;
  /** Audit trail. */
  readonly audit: AuditPort;
  /** Clock. */
  readonly clock: Clock;
  /** Identifier source. */
  readonly ids: Ids;
  /** Logger. */
  readonly logger: DomainLogger;
  /** Business metrics. */
  readonly metrics: DomainMetrics;
  /** Function configuration. */
  readonly config: RobotsConfig;
}

/** Per-invocation facts: who asked, under which correlation identifier, and how much time is left. */
export interface InvocationContext {
  /** Correlation identifier that follows the request through the logs and the audit trail. */
  readonly correlationId: CorrelationId;
  /** Declared identity of the caller. */
  readonly actor: Actor;
  /** Remaining time of the invocation. */
  readonly deadline: Deadline;
}
