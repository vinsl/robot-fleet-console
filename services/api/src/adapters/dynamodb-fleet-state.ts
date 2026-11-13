/**
 * Live state of the robots over DynamoDB: one item per robot in the fleet table, written with conditional
 * updates so that a late or duplicated sample cannot overwrite a newer one.
 *
 * The item is keyed by site and robot. Ordering is by `(bootId, seq)`, which the store compares in the
 * condition, so the order of arrival does not matter. A robot marked OFFLINE keeps a watermark: a sample
 * received before that moment is refused, so a message delayed past a disconnect cannot revive the robot.
 */
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  RobotLiveStateSchema,
  SiteIdSchema,
  type RobotId,
  type RobotLiveState,
  type SiteId,
} from "@mfc/protocol";
import { isAwsError } from "./aws-errors";
import type {
  FleetStatePort,
  GoodbyeRecord,
  ObserveOutcome,
  PresenceChange,
  PresenceOutcome,
  StateObservation,
} from "../domain/live/ports";
import type { Clock } from "../domain/ports";

/**
 * Condition of an observation. It is compared as written: the stored item must still be older (by boot,
 * then by sequence), and must not be marked OFFLINE at or after the time the sample was received.
 *
 * The first clause also accepts an item without a boot: an OFFLINE mark on a robot that never reported
 * creates such an item, and it must not block the first sample of that robot.
 */
const OBSERVE_CONDITION =
  "(attribute_not_exists(pk) OR attribute_not_exists(bootId) OR bootId < :boot OR (bootId = :boot AND seq < :seq)) AND (attribute_not_exists(offlineAtMs) OR offlineAtMs < :recv)";

/** OFFLINE mark with a version: applied when no newer presence version is stored. Upserts the item. */
const OFFLINE_VERSION_CONDITION =
  "attribute_not_exists(presenceVersion) OR presenceVersion < :version";

/** OFFLINE mark without a version: applied when no later offline mark is stored. Upserts the item. */
const OFFLINE_TIME_CONDITION = "attribute_not_exists(offlineAtMs) OR offlineAtMs < :at";

/** ONLINE record with a version. The item must exist: a connection never creates a robot's live item. */
const PRESENCE_VERSION_CONDITION =
  "attribute_exists(pk) AND (attribute_not_exists(presenceVersion) OR presenceVersion < :version)";

/** ONLINE record without a version. The item must exist; the later offline mark must be older. */
const PRESENCE_TIME_CONDITION =
  "attribute_exists(pk) AND (attribute_not_exists(offlineAtMs) OR offlineAtMs < :at)";

/** Pages read by a site listing, so one call cannot read an unbounded fleet. */
const LIST_MAX_PAGES = 3;

/**
 * Partition key of a site.
 *
 * @param siteId - The site.
 * @returns `SITE#<siteId>`.
 */
function sitePartition(siteId: SiteId): string {
  return `SITE#${siteId}`;
}

/**
 * Sort key of a robot's live item.
 *
 * @param robotId - The robot.
 * @returns `STATE#<robotId>`.
 */
function stateSortKey(robotId: RobotId): string {
  return `STATE#${robotId}`;
}

/**
 * Tells whether a value is a plain object.
 *
 * @param value - Any value.
 * @returns `true` for a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The stored item a failed condition carries, when the store returned it.
 *
 * @param error - The rejection of the write.
 * @returns The item, or undefined when the error carries none.
 */
function storedItemOf(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error) || !("Item" in error)) {
    return undefined;
  }
  return isRecord(error.Item) ? error.Item : undefined;
}

/**
 * Builds the SET and REMOVE clauses of an update, with every attribute name and value as a placeholder so
 * that no attribute name can collide with a reserved word.
 */
class UpdateBuilder {
  private readonly names = new Map<string, string>();
  private readonly values = new Map<string, unknown>();
  private readonly sets: string[] = [];
  private readonly removes: string[] = [];

  /**
   * Adds a SET assignment.
   *
   * @param attribute - The attribute name.
   * @param value - The value to store.
   */
  set(attribute: string, value: unknown): void {
    const name = `#${attribute}`;
    const placeholder = `:v_${attribute}`;
    this.names.set(name, attribute);
    this.values.set(placeholder, value);
    this.sets.push(`${name} = ${placeholder}`);
  }

  /**
   * Adds a REMOVE of an attribute.
   *
   * @param attribute - The attribute name.
   */
  remove(attribute: string): void {
    const name = `#${attribute}`;
    this.names.set(name, attribute);
    this.removes.push(name);
  }

  /**
   * @returns The update expression.
   */
  expression(): string {
    const remove = this.removes.length > 0 ? ` REMOVE ${this.removes.join(", ")}` : "";
    return `SET ${this.sets.join(", ")}${remove}`;
  }

  /**
   * @returns The attribute names and the values of the expression.
   */
  bindings(): { names: Record<string, string>; values: Record<string, unknown> } {
    return { names: Object.fromEntries(this.names), values: Object.fromEntries(this.values) };
  }
}

/**
 * Converts a stored item into a live state. Items that have no sample yet (a presence mark alone, or a boot
 * without a battery) are not live state and are skipped.
 *
 * @param item - The stored item.
 * @returns The live state, or undefined for an item without a complete sample.
 * @throws {ZodError} When a complete item breaks the protocol rules: the store is then wrong, and failing
 * closed is safer than showing a corrupt robot.
 */
function liveStateOf(item: Record<string, unknown>): RobotLiveState | undefined {
  if (item.bootId === undefined || item.battery === undefined) {
    return undefined;
  }
  const pose =
    item.x === undefined
      ? undefined
      : { x: item.x, y: item.y, heading: item.heading, speed: item.speed };
  return RobotLiveStateSchema.parse({
    robotId: item.robotId,
    siteId: item.siteId,
    state: item.state,
    battery: item.battery,
    pose,
    missionId: item.missionId,
    errorCode: item.errorCode,
    bootId: item.bootId,
    seq: item.seq,
    ts: item.ts,
    receivedAt: item.receivedAt,
  });
}

/** Live state of the fleet over the fleet table. */
export class DynamoDbFleetState implements FleetStatePort {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   * @param clock - Source of the write time.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes an observation when it is newer than the stored one and the robot was not marked OFFLINE after it
   * was received.
   *
   * @param observation - The observation.
   * @returns `APPLIED`, `STALE` (an equal or newer sample of the same boot is stored), `STALE_BOOT` (a sample
   * of a later boot is stored), or `BEFORE_OFFLINE`.
   * @throws On infrastructure errors only.
   */
  async observe(observation: StateObservation): Promise<ObserveOutcome> {
    const update = new UpdateBuilder();
    update.set("siteId", observation.siteId);
    update.set("robotId", observation.robotId);
    update.set("state", observation.state);
    update.set("bootId", observation.bootId);
    update.set("seq", observation.seq);
    update.set("ts", observation.ts);
    update.set("receivedAt", observation.receivedAt);
    update.set("writtenAt", this.clock.now().getTime());
    update.set("updatedBy", observation.source === "telemetry" ? "telemetry" : "event");
    if (observation.battery !== undefined) {
      update.set("battery", observation.battery);
    }
    if (observation.pose !== undefined) {
      update.set("x", observation.pose.x);
      update.set("y", observation.pose.y);
      update.set("heading", observation.pose.heading);
      update.set("speed", observation.pose.speed);
    }
    // A sample without a mission or a fault clears the previous one: a finished mission must not linger.
    if (observation.missionId === undefined) {
      update.remove("missionId");
    } else {
      update.set("missionId", observation.missionId);
    }
    if (observation.errorCode === undefined) {
      update.remove("errorCode");
    } else {
      update.set("errorCode", observation.errorCode);
    }
    const { names, values } = update.bindings();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: sitePartition(observation.siteId), sk: stateSortKey(observation.robotId) },
          UpdateExpression: update.expression(),
          ConditionExpression: OBSERVE_CONDITION,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ...values,
            ":boot": observation.bootId,
            ":seq": observation.seq,
            ":recv": observation.receivedAt,
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return "APPLIED";
    } catch (error) {
      if (!isAwsError(error, "ConditionalCheckFailedException")) {
        throw error;
      }
      const stored = storedItemOf(error);
      if (
        stored !== undefined &&
        typeof stored.offlineAtMs === "number" &&
        stored.offlineAtMs >= observation.receivedAt
      ) {
        return "BEFORE_OFFLINE";
      }
      if (
        stored !== undefined &&
        typeof stored.bootId === "string" &&
        stored.bootId > observation.bootId
      ) {
        return "STALE_BOOT";
      }
      return "STALE";
    }
  }

  /**
   * Marks a robot OFFLINE after a disconnect, when that event is newer than the stored one. Creates the
   * item when the robot never reported, so the console still shows it OFFLINE.
   *
   * @param change - The presence change.
   * @returns `APPLIED`, or `STALE` when a newer presence event is stored.
   * @throws On infrastructure errors only.
   */
  async markOffline(change: PresenceChange): Promise<PresenceOutcome> {
    const update = new UpdateBuilder();
    update.set("state", "OFFLINE");
    update.set("offlineAtMs", change.atMs);
    update.set("siteId", change.siteId);
    update.set("robotId", change.robotId);
    update.set("updatedBy", "presence");
    if (change.version === undefined) {
      return this.writePresence(change, update, OFFLINE_TIME_CONDITION, { ":at": change.atMs });
    }
    update.set("presenceVersion", change.version);
    return this.writePresence(change, update, OFFLINE_VERSION_CONDITION, {
      ":version": change.version,
    });
  }

  /**
   * Records a connection, when that event is newer than the stored one. Does not change the state: the
   * state comes back with the next sample.
   *
   * @param change - The presence change.
   * @returns `APPLIED`, or `STALE`. A robot without a live item is `STALE`: a presence never creates one.
   * @throws On infrastructure errors only.
   */
  async markOnline(change: PresenceChange): Promise<PresenceOutcome> {
    const update = new UpdateBuilder();
    update.set("updatedBy", "presence");
    if (change.version === undefined) {
      return this.writePresence(change, update, PRESENCE_TIME_CONDITION, { ":at": change.atMs });
    }
    update.set("presenceVersion", change.version);
    return this.writePresence(change, update, PRESENCE_VERSION_CONDITION, {
      ":version": change.version,
    });
  }

  /**
   * Runs a presence write and maps a refused condition to `STALE`.
   *
   * @param change - The presence change.
   * @param update - The assignments.
   * @param condition - The condition of the write.
   * @param bindings - The condition values the caller adds; only the ones the condition uses.
   * @returns `APPLIED` or `STALE`.
   * @throws On infrastructure errors other than the refused condition.
   */
  private async writePresence(
    change: PresenceChange,
    update: UpdateBuilder,
    condition: string,
    bindings: Record<string, unknown>,
  ): Promise<PresenceOutcome> {
    const { names, values } = update.bindings();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: sitePartition(change.siteId), sk: stateSortKey(change.robotId) },
          UpdateExpression: update.expression(),
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ...values, ...bindings },
        }),
      );
      return "APPLIED";
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return "STALE";
      }
      throw error;
    }
  }

  /**
   * Records a goodbye for the boot a robot is running. Written only when the robot has a live item and that
   * item holds the same boot (or no boot yet). A goodbye without a live item is not stored: a bare item would
   * hide the robot from the site listing.
   *
   * @param change - The site, the robot and the announced boot.
   * @throws On infrastructure errors only.
   */
  async markGoodbye(change: { siteId: SiteId; robotId: RobotId; bootId: string }): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: sitePartition(change.siteId), sk: stateSortKey(change.robotId) },
          UpdateExpression: "SET goodbyeBootId = :boot",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(bootId) OR bootId = :boot)",
          ExpressionAttributeValues: { ":boot": change.bootId },
        }),
      );
    } catch (error) {
      if (!isAwsError(error, "ConditionalCheckFailedException")) {
        throw error;
      }
    }
  }

  /**
   * Reads the boot of the stored state and the boot of the last goodbye, for the offline rule.
   *
   * @param siteId - The site.
   * @param robotId - The robot.
   * @returns The two boots, each undefined when absent.
   * @throws On infrastructure errors only.
   */
  async readGoodbye(siteId: SiteId, robotId: RobotId): Promise<GoodbyeRecord> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: sitePartition(siteId), sk: stateSortKey(robotId) },
        ConsistentRead: true,
        ProjectionExpression: "bootId, goodbyeBootId",
      }),
    );
    const item: unknown = result.Item;
    if (!isRecord(item)) {
      return { bootId: undefined, goodbyeBootId: undefined };
    }
    return {
      bootId: typeof item.bootId === "string" ? item.bootId : undefined,
      goodbyeBootId: typeof item.goodbyeBootId === "string" ? item.goodbyeBootId : undefined,
    };
  }

  /**
   * Lists the live state of every active robot of a site that has a complete sample. Reads at most a few pages.
   *
   * The registry decides which robots exist: the last sample of a retired robot stays in the table, so it is left out
   * here, or the console would show it offline for ever.
   *
   * @param siteId - The site.
   * @returns The live states, in the order the store returns them.
   * @throws On infrastructure errors only, or when a stored sample breaks the protocol rules.
   */
  async listSite(siteId: SiteId): Promise<RobotLiveState[]> {
    const states: RobotLiveState[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": sitePartition(siteId), ":prefix": "STATE#" },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of result.Items ?? []) {
        const state = liveStateOf(item);
        if (state !== undefined) {
          states.push(state);
        }
      }
      startKey = result.LastEvaluatedKey;
      if (startKey === undefined) {
        break;
      }
    }
    if (states.length === 0) {
      return states;
    }
    const retired = await this.retiredRobotIds(siteId);
    return states.filter((state) => !retired.has(state.robotId));
  }

  /**
   * Reads the identifiers of the retired robots of a site from the registry rows. Only the sort key and the status
   * are projected, so a registry item never carries a certificate reference through this path.
   *
   * @param siteId - The site.
   * @returns The identifiers of the robots whose registry status is RETIRED.
   */
  private async retiredRobotIds(siteId: SiteId): Promise<ReadonlySet<string>> {
    const retired = new Set<string>();
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": sitePartition(siteId), ":prefix": "ROBOT#" },
          ProjectionExpression: "sk, #status",
          ExpressionAttributeNames: { "#status": "status" },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of result.Items ?? []) {
        if (isRecord(item) && item.status === "RETIRED" && typeof item.sk === "string") {
          retired.add(item.sk.slice("ROBOT#".length));
        }
      }
      startKey = result.LastEvaluatedKey;
      if (startKey === undefined) {
        break;
      }
    }
    return retired;
  }

  /**
   * The site a robot is claimed for.
   *
   * @param robotId - The robot.
   * @returns The site, or null when the robot has no claim.
   * @throws On infrastructure errors only.
   */
  async siteOf(robotId: RobotId): Promise<SiteId | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `ROBOTID#${robotId}`, sk: "CLAIM" },
        ConsistentRead: true,
        ProjectionExpression: "siteId",
      }),
    );
    const parsed = SiteIdSchema.safeParse(isRecord(result.Item) ? result.Item.siteId : undefined);
    return parsed.success ? parsed.data : null;
  }
}
