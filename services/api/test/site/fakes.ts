/**
 * In-memory doubles of the site ports: the store of the profile and the versions, the object store of the map
 * files, and the metrics. Each double keeps what it receives, so a test can assert on the calls, and each one
 * follows the contract stated on its port (conditions, `null` at the cap, the pinned object versions).
 */
import { createHash } from "node:crypto";
import { SITE_MAP_CONTENT_TYPE, type Actor, type SiteId } from "@mfc/protocol";
import { FakeAudit } from "../fakes/fake-kvs-audit";
import { FixedClock, SequentialIds } from "../fakes/fixed";
import { RecordingLogger } from "../fakes/recording";
import {
  MapObjectTooLargeError,
  type MapObjectHead,
  type MapObjectStore,
  type MapObjectText,
  type MapRecord,
  type PinnedMap,
  type PresignedDownload,
  type PresignedUpload,
  type SiteCall,
  type SiteDeps,
  type SiteMetricName,
  type SiteMetrics,
  type SiteRecord,
  type SiteStore,
} from "../../src/domain/site/ports";

/** Instant the fakes start from. */
export const SITE_START = new Date("2026-11-02T10:00:00.000Z");

/** Actor of the requests the tests make. A fixed fake subject, not a real user. */
export const TEST_ACTOR: Actor = "00000000-0000-4000-8000-000000000001";

/** Correlation identifier of the requests the tests make. */
export const TEST_CORRELATION = "corr-00000001";

/** Host of the fake presigned URLs. Fake, and not a real bucket. */
const FAKE_BUCKET_HOST = "mfc-demo-site-maps-test.s3.eu-west-3.amazonaws.com";

/**
 * Builds the call of a write request for the tests.
 *
 * @returns The call, with the fixed actor and correlation identifier.
 */
export function testCall(): SiteCall {
  return { actor: TEST_ACTOR, correlationId: TEST_CORRELATION };
}

/**
 * The profile of a site with no item yet, as the store reports the default.
 *
 * @returns A record with no name, no active version and no allocated version.
 */
function defaultSiteRecord(): SiteRecord {
  return { name: null, activeVersion: null, nextVersion: 0, updatedAt: null };
}

/**
 * Builds the key of a version in the in-memory maps.
 *
 * @param siteId - The site.
 * @param version - The version.
 * @returns The key, prefixed by the site so the versions of one site can be listed.
 */
function keyOf(siteId: SiteId, version: number): string {
  return `${siteId}#${String(version)}`;
}

/** Store of the site profile and of its map versions, kept in memory. */
export class InMemorySiteStore implements SiteStore {
  /** Profiles by site identifier. */
  readonly sites = new Map<SiteId, SiteRecord>();
  /** Versions by site and version number. */
  readonly maps = new Map<string, MapRecord>();
  /** Expiry of each pending version, by key, in epoch seconds. */
  readonly expiries = new Map<string, number>();
  /** Names of the port methods called, in order. Used to assert that a refused request wrote nothing. */
  readonly calls: string[] = [];

  /**
   * Adds a version directly, without going through the upload path. For arranging test state.
   *
   * @param siteId - The site.
   * @param record - The version to add.
   */
  seedMap(siteId: SiteId, record: MapRecord): void {
    this.maps.set(keyOf(siteId, record.version), record);
  }

  /**
   * Sets a site profile directly. For arranging test state.
   *
   * @param siteId - The site.
   * @param record - The profile.
   */
  seedSite(siteId: SiteId, record: SiteRecord): void {
    this.sites.set(siteId, record);
  }

  /**
   * @param siteId - The site.
   * @returns The profile, or `null`.
   */
  getSite(siteId: SiteId): Promise<SiteRecord | null> {
    this.calls.push("getSite");
    return Promise.resolve(this.sites.get(siteId) ?? null);
  }

  /**
   * @param siteId - The site.
   * @param name - The new name.
   * @param nowIso - The instant of the change.
   * @returns Resolves once the name is stored.
   */
  putName(siteId: SiteId, name: string, nowIso: string): Promise<void> {
    this.calls.push("putName");
    const current = this.sites.get(siteId) ?? defaultSiteRecord();
    this.sites.set(siteId, { ...current, name, updatedAt: nowIso });
    return Promise.resolve();
  }

  /**
   * Allocates the number and stores the record in one step, as the transaction of the adapter does: the counter
   * only moves together with the record.
   *
   * @param siteId - The site.
   * @param max - The cap.
   * @param draft - Builds the record of the allocated number.
   * @param expiresAtEpoch - The expiry.
   * @returns The allocated number, or `null` at the cap.
   */
  reserveMap(
    siteId: SiteId,
    max: number,
    draft: (version: number) => MapRecord,
    expiresAtEpoch: number,
  ): Promise<number | null> {
    this.calls.push("reserveMap");
    const current = this.sites.get(siteId) ?? defaultSiteRecord();
    if (current.nextVersion >= max) {
      return Promise.resolve(null);
    }
    const version = current.nextVersion + 1;
    const key = keyOf(siteId, version);
    this.maps.set(key, draft(version));
    this.expiries.set(key, expiresAtEpoch);
    this.sites.set(siteId, { ...current, nextVersion: version });
    return Promise.resolve(version);
  }

  /**
   * @param siteId - The site.
   * @param version - The version.
   * @returns The version, or `null`.
   */
  getMap(siteId: SiteId, version: number): Promise<MapRecord | null> {
    this.calls.push("getMap");
    return Promise.resolve(this.maps.get(keyOf(siteId, version)) ?? null);
  }

  /**
   * @param siteId - The site.
   * @param limit - The largest number to return.
   * @returns The versions of the site, newest first.
   */
  listMaps(siteId: SiteId, limit: number): Promise<MapRecord[]> {
    this.calls.push("listMaps");
    const prefix = `${siteId}#`;
    const records = [...this.maps.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .sort((left, right) => right.version - left.version);
    return Promise.resolve(records.slice(0, limit));
  }

  /**
   * @param siteId - The site.
   * @param version - The version.
   * @param pinned - The pinned object facts.
   * @returns `updated`, or `already` when the version is not pending.
   */
  markValid(siteId: SiteId, version: number, pinned: PinnedMap): Promise<"updated" | "already"> {
    this.calls.push("markValid");
    const key = keyOf(siteId, version);
    const current = this.maps.get(key);
    if (current === undefined || current.status !== "PENDING") {
      return Promise.resolve("already");
    }
    this.maps.set(key, { ...current, status: "VALID", ...pinned });
    this.expiries.delete(key);
    return Promise.resolve("updated");
  }

  /**
   * @param siteId - The site.
   * @param version - The version.
   * @param nowIso - The instant of the change.
   * @returns `activated`, or `not-valid` when the version is not validated.
   */
  activate(siteId: SiteId, version: number, nowIso: string): Promise<"activated" | "not-valid"> {
    this.calls.push("activate");
    if (this.maps.get(keyOf(siteId, version))?.status !== "VALID") {
      return Promise.resolve("not-valid");
    }
    const site = this.sites.get(siteId) ?? defaultSiteRecord();
    this.sites.set(siteId, { ...site, activeVersion: version, updatedAt: nowIso });
    return Promise.resolve("activated");
  }
}

/** One stored object version of the fake object store. */
interface StoredObject {
  readonly body: string;
  readonly contentType: string;
  readonly versionId: string;
}

/** Object store of the map files, kept in memory with object versions. */
export class FakeMapObjects implements MapObjectStore {
  /** Object versions by key, oldest first. The last one is the current object. */
  readonly objects = new Map<string, StoredObject[]>();
  /** Presigned downloads requested, in order. */
  readonly downloads: { key: string; versionId: string; version: number }[] = [];
  /** Keys of the presigned uploads requested, in order. */
  readonly uploads: string[] = [];
  private serial = 0;

  /**
   * Stores a new object version at a key, as an upload does.
   *
   * @param key - The key.
   * @param body - The body, stored as UTF-8 text.
   * @param contentType - The media type the object carries.
   * @returns The object version identifier.
   */
  put(key: string, body: string, contentType: string = SITE_MAP_CONTENT_TYPE): string {
    this.serial += 1;
    const versionId = `v${String(this.serial)}`;
    this.objects.set(key, [...(this.objects.get(key) ?? []), { body, contentType, versionId }]);
    return versionId;
  }

  /**
   * @param key - The key.
   * @returns The presigned POST of the key, with fake credentials.
   */
  presignUpload(key: string): Promise<PresignedUpload> {
    this.uploads.push(key);
    return Promise.resolve({
      url: `https://${FAKE_BUCKET_HOST}/`,
      fields: {
        key,
        "Content-Type": SITE_MAP_CONTENT_TYPE,
        policy: "fake-policy",
        "x-amz-signature": "fake-signature",
      },
      expiresAt: new Date(SITE_START.getTime() + 300_000).toISOString(),
    });
  }

  /**
   * @param key - The key.
   * @returns The metadata of the current object, or `null`.
   */
  head(key: string): Promise<MapObjectHead | null> {
    const current = this.objects.get(key)?.at(-1);
    if (current === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      sizeBytes: Buffer.byteLength(current.body, "utf8"),
      contentType: current.contentType,
      versionId: current.versionId,
    });
  }

  /**
   * @param key - The key.
   * @param versionId - The object version.
   * @param maxBytes - The cap.
   * @returns The text and its digest.
   * @throws {MapObjectTooLargeError} When the object is above the cap.
   */
  readText(key: string, versionId: string, maxBytes: number): Promise<MapObjectText> {
    const stored = this.objects.get(key)?.find((object) => object.versionId === versionId);
    if (stored === undefined) {
      return Promise.reject(new Error("NoSuchVersion"));
    }
    const bytes = Buffer.from(stored.body, "utf8");
    if (bytes.byteLength > maxBytes) {
      return Promise.reject(new MapObjectTooLargeError());
    }
    return Promise.resolve({
      text: stored.body,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  /**
   * @param key - The key.
   * @param versionId - The object version.
   * @param version - The map version number.
   * @returns A fake presigned URL, which names the version.
   */
  presignDownload(key: string, versionId: string, version: number): Promise<PresignedDownload> {
    this.downloads.push({ key, versionId, version });
    return Promise.resolve({
      url: `https://${FAKE_BUCKET_HOST}/${key}?versionId=${versionId}&X-Amz-Signature=fake`,
      expiresAt: new Date(SITE_START.getTime() + 300_000).toISOString(),
    });
  }
}

/** Metrics sink of the site use cases that keeps the counts. */
export class RecordingSiteMetrics implements SiteMetrics {
  /** Counts by metric name. */
  readonly counts = new Map<SiteMetricName, number>();

  /** @param name - The metric to count. */
  count(name: SiteMetricName): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * @param name - The metric.
   * @returns How many times it was counted.
   */
  countOf(name: SiteMetricName): number {
    return this.counts.get(name) ?? 0;
  }
}

/** Everything a site test needs: the dependencies, and the fakes behind them for assertions. */
export interface SiteWorld {
  /** The dependencies to pass to the use cases. */
  readonly deps: SiteDeps;
  /** The profile and version store. */
  readonly store: InMemorySiteStore;
  /** The object store. */
  readonly objects: FakeMapObjects;
  /** The audit trail. */
  readonly audit: FakeAudit;
  /** The logger. */
  readonly logger: RecordingLogger;
  /** The metrics. */
  readonly metrics: RecordingSiteMetrics;
}

/**
 * Builds a fresh world: empty stores, a clock at {@link SITE_START}, sequential identifiers.
 *
 * @returns The world.
 */
export function createSiteWorld(): SiteWorld {
  const store = new InMemorySiteStore();
  const objects = new FakeMapObjects();
  const audit = new FakeAudit();
  const logger = new RecordingLogger();
  const metrics = new RecordingSiteMetrics();
  return {
    deps: {
      store,
      objects,
      audit,
      clock: new FixedClock(SITE_START),
      ids: new SequentialIds(),
      logger,
      metrics,
    },
    store,
    objects,
    audit,
    logger,
    metrics,
  };
}
