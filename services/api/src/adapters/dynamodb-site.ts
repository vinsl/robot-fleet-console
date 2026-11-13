/**
 * Site profile and map versions over DynamoDB, in the fleet table.
 *
 * A site is one partition, `SITE#<siteId>`. Its profile is the item `META`, and each map version is an item
 * `MAP#<000001>` (six digits, so the sort key order is the version order and a `begins_with` query lists the
 * versions newest first). A `PENDING` version carries the table's TTL attribute, so an upload that never
 * happens is removed after a day.
 *
 * Every item read is parsed with a schema before it reaches the domain: a stored item that does not match is an
 * internal error, never a value passed on as if it were valid.
 */
import {
  ActorSchema,
  IsoMsSchema,
  MAP_MAX_VERSIONS,
  MapStatusSchema,
  MapSummarySchema,
  MapVersionNumberSchema,
  SiteNameSchema,
  type SiteId,
} from "@mfc/protocol";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { MapRecord, PinnedMap, SiteRecord, SiteStore } from "../domain/site/ports";
import { isAwsError } from "./aws-errors";

/** Sort key of the profile item of a site. */
const META_SORT_KEY = "META";

/** Prefix of the sort key of a map version item. The version follows it, zero-padded to six digits. */
const MAP_SORT_PREFIX = "MAP#";

/** Stored profile item. Every attribute is optional: a site that only allocated a version has no name yet. */
const SiteItemSchema = z.object({
  name: SiteNameSchema.optional(),
  activeVersion: MapVersionNumberSchema.optional(),
  nextVersion: z.int().min(0).max(MAP_MAX_VERSIONS).optional(),
  updatedAt: IsoMsSchema.optional(),
});

/** Stored map version item. The pinned attributes are present once the version is `VALID`. */
const MapItemSchema = z.object({
  version: MapVersionNumberSchema,
  status: MapStatusSchema,
  createdAt: IsoMsSchema,
  createdBy: ActorSchema,
  s3Key: z.string().min(1).max(256),
  s3VersionId: z.string().min(1).max(1024).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sizeBytes: z.int().min(0).optional(),
  summary: MapSummarySchema.optional(),
});

/**
 * Reasons of a cancelled transaction, one per item in the order the request named them. Only the code is read:
 * the message of a cancellation can echo the item.
 */
const CancellationReasonsSchema = z.object({
  CancellationReasons: z.array(z.object({ Code: z.string().optional() })),
});

/**
 * Attempts of one reservation under contention. Each attempt re-reads the counter; a number is only ever written
 * together with the counter that allocated it, so a retry cannot skip or reuse one.
 */
const RESERVE_ATTEMPTS = 5;

/**
 * Partition key of a site.
 *
 * @param siteId - The site.
 * @returns The partition key.
 */
function partitionOf(siteId: SiteId): string {
  return `SITE#${siteId}`;
}

/**
 * Reason codes of a cancelled transaction, one per item in the order the request named them.
 *
 * @param error - The rejection of the transaction.
 * @returns The codes, or an empty list when the error is not a cancellation with reasons.
 */
function cancellationCodesOf(error: unknown): readonly string[] {
  if (!isAwsError(error, "TransactionCanceledException")) {
    return [];
  }
  const parsed = CancellationReasonsSchema.safeParse(error);
  return parsed.success
    ? parsed.data.CancellationReasons.flatMap((reason) =>
        reason.Code === undefined ? [] : [reason.Code],
      )
    : [];
}

/**
 * Tells whether a failed transaction was cancelled by a state condition. Any other cancellation reason, such as a
 * conflict with a concurrent transaction, is a failure and must not be read as "the version is not valid".
 *
 * @param error - The rejection of the transaction.
 * @returns True only for a cancellation whose reasons include `ConditionalCheckFailed`.
 */
function isStateConditionFailure(error: unknown): boolean {
  return cancellationCodesOf(error).includes("ConditionalCheckFailed");
}

/**
 * Tells whether a failed reservation is worth another attempt: the counter moved under it, or another transaction
 * touched the same items. A retry re-reads the counter, so it never reuses a number.
 *
 * @param error - The rejection of the transaction.
 * @returns True for a condition failure or a transaction conflict.
 */
function isRetryableReservation(error: unknown): boolean {
  if (isAwsError(error, "TransactionConflictException")) {
    return true;
  }
  return cancellationCodesOf(error).some(
    (code) => code === "ConditionalCheckFailed" || code === "TransactionConflict",
  );
}

/**
 * Sort key of a map version. Six digits, so the keys of one site sort in version order.
 *
 * @param version - The version number.
 * @returns The sort key.
 */
function mapSortKey(version: number): string {
  return `${MAP_SORT_PREFIX}${String(version).padStart(6, "0")}`;
}

/**
 * Projects a stored map item onto the domain record.
 *
 * @param item - The raw item, as DynamoDB returned it.
 * @returns The domain record.
 * @throws When the item does not match the stored shape: an internal error, never a partial value.
 */
function mapRecordOf(item: unknown): MapRecord {
  const parsed = MapItemSchema.parse(item);
  return {
    version: parsed.version,
    status: parsed.status,
    createdAt: parsed.createdAt,
    createdBy: parsed.createdBy,
    s3Key: parsed.s3Key,
    s3VersionId: parsed.s3VersionId ?? null,
    sha256: parsed.sha256 ?? null,
    sizeBytes: parsed.sizeBytes ?? null,
    summary: parsed.summary ?? null,
  };
}

/** Site profile and map versions over the fleet table. */
export class DynamoDbSiteStore implements SiteStore {
  /**
   * @param client - Document client. Only `send` is used, so tests can supply a double.
   * @param tableName - The fleet table.
   */
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  /**
   * @param siteId - The site.
   * @returns The profile, or `null` when the site has no profile item.
   */
  async getSite(siteId: SiteId): Promise<SiteRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionOf(siteId), sk: META_SORT_KEY },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      return null;
    }
    const item = SiteItemSchema.parse(result.Item);
    return {
      name: item.name ?? null,
      activeVersion: item.activeVersion ?? null,
      nextVersion: item.nextVersion ?? 0,
      updatedAt: item.updatedAt ?? null,
    };
  }

  /**
   * Sets the name and the change instant, creating the profile when absent. The other attributes are kept.
   *
   * @param siteId - The site.
   * @param name - The validated name.
   * @param nowIso - The instant of the change.
   */
  async putName(siteId: SiteId, name: string, nowIso: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: partitionOf(siteId), sk: META_SORT_KEY },
        UpdateExpression: "SET #name = :name, #updatedAt = :now",
        ExpressionAttributeNames: { "#name": "name", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":name": name, ":now": nowIso },
      }),
    );
  }

  /**
   * Allocates the next version number and stores its `PENDING` record in one transaction. The counter update is
   * conditional on the value that was read and on the cap, and the record is conditional on its key being free:
   * either both writes apply or neither does, so a failed upload never burns a number.
   *
   * A counter that moved under the read, or a concurrent transaction on the same items, is retried after a fresh
   * read, up to {@link RESERVE_ATTEMPTS} times. The cap is answered from the fresh read, not from the condition, so
   * a site at its cap gets `null` on any attempt.
   *
   * @param siteId - The site.
   * @param max - The cap.
   * @param draft - Builds the record of the allocated number.
   * @param expiresAtEpoch - The expiry, for the TTL of the table.
   * @returns The allocated number, or `null` when the cap is reached.
   * @throws The SDK error for any failure other than a retryable conflict, and when every attempt conflicted.
   */
  async reserveMap(
    siteId: SiteId,
    max: number,
    draft: (version: number) => MapRecord,
    expiresAtEpoch: number,
  ): Promise<number | null> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
      const current = (await this.getSite(siteId))?.nextVersion ?? 0;
      if (current >= max) {
        return null;
      }
      const version = current + 1;
      const record = draft(version);
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: partitionOf(siteId), sk: META_SORT_KEY },
                  UpdateExpression: "SET #nextVersion = :version",
                  // An absent counter reads as zero. The cap is part of the condition, not only of the read.
                  ConditionExpression:
                    "attribute_not_exists(#nextVersion) OR (#nextVersion = :current AND #nextVersion < :max)",
                  ExpressionAttributeNames: { "#nextVersion": "nextVersion" },
                  ExpressionAttributeValues: {
                    ":version": version,
                    ":current": current,
                    ":max": max,
                  },
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    pk: partitionOf(siteId),
                    sk: mapSortKey(version),
                    kind: "MAP",
                    version,
                    status: record.status,
                    createdAt: record.createdAt,
                    createdBy: record.createdBy,
                    s3Key: record.s3Key,
                    expiresAt: expiresAtEpoch,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return version;
      } catch (error) {
        if (!isRetryableReservation(error)) {
          throw error;
        }
      }
    }
    throw new Error("map version reservation kept conflicting");
  }

  /**
   * @param siteId - The site.
   * @param version - The version.
   * @returns The version, or `null` when it does not exist.
   */
  async getMap(siteId: SiteId, version: number): Promise<MapRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionOf(siteId), sk: mapSortKey(version) },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined ? null : mapRecordOf(result.Item);
  }

  /**
   * Lists the versions of a site, newest first.
   *
   * @param siteId - The site.
   * @param limit - The largest number to return.
   * @returns The versions.
   */
  async listMaps(siteId: SiteId, limit: number): Promise<MapRecord[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": partitionOf(siteId), ":prefix": MAP_SORT_PREFIX },
        ScanIndexForward: false,
        Limit: limit,
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? []).map(mapRecordOf);
  }

  /**
   * Pins a `PENDING` version to its validated object. The condition makes the write apply once: a second
   * validation finds the version no longer pending and is told so.
   *
   * @param siteId - The site.
   * @param version - The version.
   * @param pinned - The pinned object facts.
   * @returns `updated`, or `already` when the version was not pending.
   * @throws The SDK error for any failure other than the state condition.
   */
  async markValid(
    siteId: SiteId,
    version: number,
    pinned: PinnedMap,
  ): Promise<"updated" | "already"> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: partitionOf(siteId), sk: mapSortKey(version) },
          UpdateExpression:
            "SET #status = :valid, #s3VersionId = :versionId, #sha256 = :sha256, #sizeBytes = :sizeBytes, #summary = :summary REMOVE #expiresAt",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: {
            "#status": "status",
            "#s3VersionId": "s3VersionId",
            "#sha256": "sha256",
            "#sizeBytes": "sizeBytes",
            "#summary": "summary",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":valid": "VALID",
            ":pending": "PENDING",
            ":versionId": pinned.s3VersionId,
            ":sha256": pinned.sha256,
            ":sizeBytes": pinned.sizeBytes,
            ":summary": pinned.summary,
          },
        }),
      );
      return "updated";
    } catch (error) {
      if (isAwsError(error, "ConditionalCheckFailedException")) {
        return "already";
      }
      throw error;
    }
  }

  /**
   * Makes a version the active one. The state of the version is checked in the same transaction as the write
   * of the profile, so a version that stopped being valid cannot be activated.
   *
   * @param siteId - The site.
   * @param version - The version.
   * @param nowIso - The instant of the change.
   * @returns `activated`, or `not-valid` when the version is not valid at write time.
   * @throws The SDK error for any failure other than the state condition, including a transaction conflict.
   */
  async activate(
    siteId: SiteId,
    version: number,
    nowIso: string,
  ): Promise<"activated" | "not-valid"> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: partitionOf(siteId), sk: mapSortKey(version) },
                ConditionExpression: "#status = :valid",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":valid": "VALID" },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: partitionOf(siteId), sk: META_SORT_KEY },
                UpdateExpression: "SET #activeVersion = :version, #updatedAt = :now",
                ExpressionAttributeNames: {
                  "#activeVersion": "activeVersion",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: { ":version": version, ":now": nowIso },
              },
            },
          ],
        }),
      );
      return "activated";
    } catch (error) {
      if (isStateConditionFailure(error)) {
        return "not-valid";
      }
      throw error;
    }
  }
}
