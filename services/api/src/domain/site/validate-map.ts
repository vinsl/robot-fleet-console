/**
 * Validation of an uploaded map: the stored object is read, parsed and checked against the version it was
 * uploaded for, then pinned to the object version that was checked.
 *
 * The object is read at the version the object store reports at the head, and the pinned identifier is that
 * same version. A later re-upload to the same key is a new object version, which the activation and the
 * download never see. Any refusal leaves the version `PENDING`, so the operator can upload again.
 */
import {
  SITE_MAP_CONTENT_TYPE,
  SITE_MAP_MAX_BYTES,
  parseSiteMap,
  summarizeSiteMap,
  type MapVersion,
  type SiteId,
  type SiteMap,
} from "@mfc/protocol";
import { z } from "zod";
import { PENDING_RETENTION_S } from "./create-map";
import { writeSiteAudit } from "./audit";
import { mapVersionOf } from "./list-maps";
import {
  MapObjectTooLargeError,
  type MapObjectStore,
  type MapObjectText,
  type MapRecord,
  type PinnedMap,
  type SiteCall,
  type SiteDeps,
} from "./ports";
import {
  SITE_PROBLEMS,
  refuse,
  succeed,
  type SiteIssue,
  type SiteProblem,
  type SiteResult,
} from "./result";

/** Why an uploaded object was refused. Logged as a fixed word, never with the content. */
type RefusalReason = "no-object" | "too-large" | "media-type" | "schema" | "version-mismatch";

/**
 * The verdict of inspecting an uploaded object: the pinned facts, or the refusal, its reason and, for a schema
 * refusal, the issues as plain data.
 */
type Inspection =
  | { readonly ok: true; readonly pinned: PinnedMap }
  | {
      readonly ok: false;
      readonly problem: SiteProblem;
      readonly reason: RefusalReason;
      readonly issues?: readonly SiteIssue[];
    };

/** Lifetime of a `PENDING` reservation in milliseconds. The table removes it lazily, so the check is made here. */
const PENDING_RETENTION_MS = PENDING_RETENTION_S * 1000;

/**
 * Tells whether a `PENDING` reservation is older than its retention. The table's TTL is lazy, so an expired slot
 * may still be stored; it is refused as if it did not exist.
 *
 * @param record - The `PENDING` version.
 * @param nowMs - The current instant, in milliseconds since the epoch, from the injected clock.
 * @returns True when the reservation is older than the retention.
 */
function isExpiredPending(record: MapRecord, nowMs: number): boolean {
  return Date.parse(record.createdAt) + PENDING_RETENTION_MS < nowMs;
}

/**
 * Reads and checks the object of a `PENDING` version. Every check is a refusal with a reason; the caller decides
 * what to log and what to audit.
 *
 * @param objects - The object store.
 * @param record - The `PENDING` version.
 * @param version - The version number the request names; the file must declare the same one.
 * @returns The pinned facts of the object, or the refusal.
 */
async function inspect(
  objects: MapObjectStore,
  record: MapRecord,
  version: number,
): Promise<Inspection> {
  const head = await objects.head(record.s3Key);
  if (head === null) {
    return { ok: false, problem: SITE_PROBLEMS.noUpload, reason: "no-object" };
  }
  if (head.sizeBytes > SITE_MAP_MAX_BYTES) {
    return { ok: false, problem: SITE_PROBLEMS.mapRejected, reason: "too-large" };
  }
  if (head.contentType !== SITE_MAP_CONTENT_TYPE) {
    return { ok: false, problem: SITE_PROBLEMS.mapRejected, reason: "media-type" };
  }

  let read: MapObjectText;
  try {
    read = await objects.readText(record.s3Key, head.versionId, SITE_MAP_MAX_BYTES);
  } catch (error) {
    if (error instanceof MapObjectTooLargeError) {
      return { ok: false, problem: SITE_PROBLEMS.mapRejected, reason: "too-large" };
    }
    throw error;
  }

  let map: SiteMap;
  try {
    map = parseSiteMap(read.text);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }
    return {
      ok: false,
      problem: SITE_PROBLEMS.mapRejected,
      reason: "schema",
      issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    };
  }
  if (map.fleet.version !== version) {
    return { ok: false, problem: SITE_PROBLEMS.mapRejected, reason: "version-mismatch" };
  }
  return {
    ok: true,
    pinned: {
      s3VersionId: head.versionId,
      sha256: read.sha256,
      sizeBytes: head.sizeBytes,
      summary: summarizeSiteMap(map),
    },
  };
}

/**
 * Projects a stored version for the response, with the active flag read now. Every branch of the validation that
 * answers with a version goes through here, so a version validated or activated by a concurrent request reads
 * the same as one this request validated.
 *
 * @param deps - The site ports.
 * @param siteId - The site.
 * @param record - The version, as stored.
 * @returns The version, with its active flag.
 */
async function projectRecord(
  deps: SiteDeps,
  siteId: SiteId,
  record: MapRecord,
): Promise<SiteResult<MapVersion>> {
  const site = await deps.store.getSite(siteId);
  return succeed(mapVersionOf(record, site?.activeVersion ?? null));
}

/**
 * Projects a version as it is stored at this instant, after a write of this request.
 *
 * @param deps - The site ports.
 * @param siteId - The site.
 * @param version - The version number.
 * @returns The version, or a `404` when it no longer exists.
 */
async function projectCurrent(
  deps: SiteDeps,
  siteId: SiteId,
  version: number,
): Promise<SiteResult<MapVersion>> {
  const current = await deps.store.getMap(siteId, version);
  return current === null
    ? refuse(SITE_PROBLEMS.mapNotFound)
    : projectRecord(deps, siteId, current);
}

/**
 * Validates the uploaded map of a version and pins it. Idempotent: a version that is already `VALID` is returned
 * as it is, with no read of the object and no second audit record. A `PENDING` reservation older than its retention
 * is refused as not found, since the table may not have removed it yet.
 *
 * @param deps - The site ports.
 * @param call - The verified caller and the correlation identifier.
 * @param siteId - The site, already checked against the caller's site.
 * @param version - The version number of the request.
 * @returns The version, now `VALID`; a `404` when the version does not exist or its reservation expired; a `422`
 * when the upload is refused.
 */
export async function validateMap(
  deps: SiteDeps,
  call: SiteCall,
  siteId: SiteId,
  version: number,
): Promise<SiteResult<MapVersion>> {
  const record = await deps.store.getMap(siteId, version);
  if (record === null) {
    return refuse(SITE_PROBLEMS.mapNotFound);
  }
  if (record.status === "VALID") {
    return projectRecord(deps, siteId, record);
  }
  if (isExpiredPending(record, deps.clock.now().getTime())) {
    return refuse(SITE_PROBLEMS.mapNotFound);
  }

  const inspection = await inspect(deps.objects, record, version);
  if (!inspection.ok) {
    deps.logger.warn("site map refused", { version, reason: inspection.reason });
    deps.metrics.count("SiteMapRejected");
    await writeSiteAudit(deps, {
      siteId,
      actor: call.actor,
      action: "site.map.validate",
      result: "REFUSED",
      problemType: inspection.problem.type,
      mapVersion: version,
      correlationId: call.correlationId,
    });
    return refuse(inspection.problem, inspection.issues);
  }

  const outcome = await deps.store.markValid(siteId, version, inspection.pinned);
  if (outcome === "already") {
    // Another request validated the version first: its result is the one to return.
    return projectCurrent(deps, siteId, version);
  }

  deps.logger.info("site map validated", { version });
  deps.metrics.count("SiteMapValidated");
  await writeSiteAudit(deps, {
    siteId,
    actor: call.actor,
    action: "site.map.validate",
    result: "SUCCEEDED",
    mapVersion: version,
    correlationId: call.correlationId,
  });
  return projectCurrent(deps, siteId, version);
}
