/**
 * Ports of the site use cases: the store of the site and its map versions, the object store of the map files,
 * and the dependencies they share with the robot use cases.
 *
 * The ports state the outcome the domain needs rather than the SDK call behind it: `reserveMap` returns
 * `null` at the cap, `markValid` says whether the version was already valid. The domain therefore never imports
 * an SDK, and the adapters are tested against the same contract as the in-memory fakes.
 */
import type { Actor, CorrelationId, MapStatus, MapSummary, SiteId } from "@mfc/protocol";
import type { AuditPort, Clock, DomainLogger, Ids } from "../ports";

/** Profile of a site as stored: the name, the active version and the counter of the versions. */
export interface SiteRecord {
  /** Display name. A site created by its first map upload has no name yet, and the caller reads its id. */
  readonly name: string | null;
  /** Version the site uses now, or `null` when none is active. */
  readonly activeVersion: number | null;
  /** Number of versions allocated so far. The next allocation returns this value plus one. */
  readonly nextVersion: number;
  /** Instant of the last change of the profile, or `null` when it never changed. */
  readonly updatedAt: string | null;
}

/** One map version as stored. The pinned fields are set once the version is `VALID`. */
export interface MapRecord {
  /** Version number, from 1 to the cap. */
  readonly version: number;
  /** `PENDING` until the stored object is validated, then `VALID`. */
  readonly status: MapStatus;
  /** Instant of the upload slot, ISO 8601 with milliseconds. */
  readonly createdAt: string;
  /** Declared identity of the user who reserved the slot. */
  readonly createdBy: Actor;
  /** Object key of the map file. Chosen by the server, never by the caller. */
  readonly s3Key: string;
  /** Object version that was validated, or `null` while pending. */
  readonly s3VersionId: string | null;
  /** SHA-256 of the validated object, hexadecimal, or `null` while pending. */
  readonly sha256: string | null;
  /** Size of the validated object in bytes, or `null` while pending. */
  readonly sizeBytes: number | null;
  /** Summary of the validated map, or `null` while pending. */
  readonly summary: MapSummary | null;
}

/** What a successful validation pins: the object version, its digest, its size and its summary. */
export interface PinnedMap {
  /** Object version that was read and parsed. Every later read uses this version. */
  readonly s3VersionId: string;
  /** SHA-256 of the object read. */
  readonly sha256: string;
  /** Size of the object read, in bytes. */
  readonly sizeBytes: number;
  /** Summary of the map read. */
  readonly summary: MapSummary;
}

/** Store of the site profile and of its map versions. */
export interface SiteStore {
  /**
   * Strongly consistent read of the site profile.
   *
   * @returns The profile, or `null` when the site has no item yet.
   */
  getSite(siteId: SiteId): Promise<SiteRecord | null>;

  /**
   * Stores the name of a site, creating the profile when absent. The other attributes are kept.
   *
   * @param siteId - The site.
   * @param name - The validated name.
   * @param nowIso - The instant of the change.
   */
  putName(siteId: SiteId, name: string, nowIso: string): Promise<void>;

  /**
   * Allocates the next map version number and stores its `PENDING` record in one atomic write, so a failed
   * reservation never consumes a number.
   *
   * @param siteId - The site.
   * @param max - The cap: no version above it is allocated.
   * @param draft - Builds the record of the number the store allocated. The object key depends on the number.
   * @param expiresAtEpoch - Expiry of the record, in seconds since the epoch, for the TTL of the table.
   * @returns The allocated number, or `null` when the cap is reached.
   */
  reserveMap(
    siteId: SiteId,
    max: number,
    draft: (version: number) => MapRecord,
    expiresAtEpoch: number,
  ): Promise<number | null>;

  /**
   * Strongly consistent read of one map version.
   *
   * @returns The version, or `null` when it does not exist.
   */
  getMap(siteId: SiteId, version: number): Promise<MapRecord | null>;

  /**
   * Lists the map versions of a site, newest first.
   *
   * @param siteId - The site.
   * @param limit - The largest number of versions to return.
   */
  listMaps(siteId: SiteId, limit: number): Promise<MapRecord[]>;

  /**
   * Moves a `PENDING` version to `VALID` and pins it, conditionally on its state.
   *
   * @returns `updated` when this call validated the version; `already` when it was not `PENDING`.
   */
  markValid(siteId: SiteId, version: number, pinned: PinnedMap): Promise<"updated" | "already">;

  /**
   * Makes a `VALID` version the active map, in one transaction with the check of its state.
   *
   * @param nowIso - The instant of the change.
   * @returns `activated`, or `not-valid` when the version is not `VALID` at write time.
   */
  activate(siteId: SiteId, version: number, nowIso: string): Promise<"activated" | "not-valid">;
}

/** Presigned upload of a map file: the POST URL, its form fields, and its expiry. */
export interface PresignedUpload {
  /** Upload URL. */
  readonly url: string;
  /** Form fields the browser posts, in order, before the file. */
  readonly fields: Record<string, string>;
  /** Instant after which the upload is refused, ISO 8601 with milliseconds. */
  readonly expiresAt: string;
}

/** Metadata of a map object, as the object store reports it. */
export interface MapObjectHead {
  /** Size of the object in bytes. */
  readonly sizeBytes: number;
  /** Media type the object was uploaded with. */
  readonly contentType: string;
  /** Version of the object, the identifier every later read pins. */
  readonly versionId: string;
}

/** Text of a map object read from a pinned version, with its digest. */
export interface MapObjectText {
  /** The text, decoded as UTF-8. */
  readonly text: string;
  /** SHA-256 of the bytes, hexadecimal. */
  readonly sha256: string;
}

/** Raised by {@link MapObjectStore.readText} when the object is larger than the cap. */
export class MapObjectTooLargeError extends Error {
  /** Creates the error. The message is fixed: it never names the object. */
  constructor() {
    super("map object is larger than the cap");
    this.name = "MapObjectTooLargeError";
  }
}

/** Object store of the map files. Keys are server-chosen; every read names an object version. */
export interface MapObjectStore {
  /**
   * Presigns a POST upload of one map file, with the size and media-type conditions the upload must meet.
   *
   * @param key - Object key, chosen by the server.
   */
  presignUpload(key: string): Promise<PresignedUpload>;

  /**
   * Reads the metadata of the current object of a key.
   *
   * @returns The metadata, or `null` when no object exists at the key.
   */
  head(key: string): Promise<MapObjectHead | null>;

  /**
   * Reads the text of one object version, stopping as soon as the cap is exceeded.
   *
   * @param key - Object key.
   * @param versionId - The object version to read.
   * @param maxBytes - The largest size accepted.
   * @returns The text and its digest.
   * @throws {MapObjectTooLargeError} When the object is larger than `maxBytes`.
   */
  readText(key: string, versionId: string, maxBytes: number): Promise<MapObjectText>;

  /**
   * Presigns a download of one object version, served as an attachment named after the map version.
   *
   * @param key - Object key.
   * @param versionId - The object version to download.
   * @param version - The map version number, which names the attachment.
   */
  presignDownload(key: string, versionId: string, version: number): Promise<PresignedDownload>;
}

/** Presigned download of one object version. */
export interface PresignedDownload {
  /** Download URL. */
  readonly url: string;
  /** Instant after which the URL is refused, ISO 8601 with milliseconds. */
  readonly expiresAt: string;
}

/** Names of the business metrics of the site use cases. */
export type SiteMetricName =
  "AuditWriteFailed" | "SiteMapValidated" | "SiteMapRejected" | "SiteMapActivated";

/** Business metrics sink of the site use cases. */
export interface SiteMetrics {
  /** Adds one to the named counter. */
  count(name: SiteMetricName): void;
}

/** Everything the site use cases depend on. */
export interface SiteDeps {
  /** Store of the profile and of the map versions. */
  readonly store: SiteStore;
  /** Object store of the map files. */
  readonly objects: MapObjectStore;
  /** Audit trail. */
  readonly audit: AuditPort;
  /** Clock. */
  readonly clock: Clock;
  /** Identifier source. */
  readonly ids: Ids;
  /** Logger. Attributes never carry a URL, a form field, a signature or a file body. */
  readonly logger: DomainLogger;
  /** Business metrics. */
  readonly metrics: SiteMetrics;
}

/**
 * Facts of one write request: the caller, validated at the boundary, and the correlation identifier that the audit
 * record carries. Read use cases need no caller and take only the site identifier.
 */
export interface SiteCall {
  /** The verified caller, as the audit actor and the creator of a map version. */
  readonly actor: Actor;
  /** Correlation identifier of the request. */
  readonly correlationId: CorrelationId;
}
