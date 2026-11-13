/**
 * Reservation of a map version and the presigned upload that fills it.
 *
 * The version number is allocated by the store, atomically, so two uploads never share a number and a client
 * never chooses one. The key is built here from the site and the number, and it is never taken from the
 * caller. The reservation is `PENDING` and expires after one day, so an upload that never happens costs
 * nothing once the table's TTL removes it.
 */
import {
  SITE_MAP_MAX_BYTES,
  MAP_MAX_VERSIONS,
  type CreateMapResponse,
  type SiteId,
} from "@mfc/protocol";
import { writeSiteAudit } from "./audit";
import type { SiteCall, SiteDeps } from "./ports";
import { SITE_PROBLEMS, refuse, succeed, type SiteResult } from "./result";

/**
 * Lifetime of a `PENDING` reservation, in seconds: a day, after which the table removes the slot. The table's TTL
 * is lazy, so validation also refuses a reservation past this age; the two must agree, hence the export.
 */
export const PENDING_RETENTION_S = 24 * 60 * 60;

/**
 * Object key of a map version. The number is zero-padded to six digits, so keys sort in version order.
 *
 * @param siteId - The site.
 * @param version - The version number, from 1 to the cap.
 * @returns The object key.
 */
export function mapObjectKey(siteId: SiteId, version: number): string {
  return `sites/${siteId}/maps/${String(version).padStart(6, "0")}.geojson`;
}

/**
 * Reserves the next version of a site and presigns its upload. The number and the `PENDING` record are written in
 * one atomic store call, so a failed upload presign or write leaves no number behind.
 *
 * @param deps - The site ports.
 * @param call - The verified caller and the correlation identifier.
 * @param siteId - The site, already checked against the caller's site.
 * @returns The upload slot, or a `409` when the site has reached its version cap.
 */
export async function createMap(
  deps: SiteDeps,
  call: SiteCall,
  siteId: SiteId,
): Promise<SiteResult<CreateMapResponse>> {
  const now = deps.clock.now();
  const version = await deps.store.reserveMap(
    siteId,
    MAP_MAX_VERSIONS,
    (allocated) => ({
      version: allocated,
      status: "PENDING",
      createdAt: now.toISOString(),
      createdBy: call.actor,
      s3Key: mapObjectKey(siteId, allocated),
      s3VersionId: null,
      sha256: null,
      sizeBytes: null,
      summary: null,
    }),
    Math.floor(now.getTime() / 1000) + PENDING_RETENTION_S,
  );
  if (version === null) {
    return refuse(SITE_PROBLEMS.versionLimit);
  }
  const upload = await deps.objects.presignUpload(mapObjectKey(siteId, version));
  await writeSiteAudit(deps, {
    siteId,
    actor: call.actor,
    action: "site.map.create",
    result: "SUCCEEDED",
    mapVersion: version,
    correlationId: call.correlationId,
  });
  return succeed({
    version,
    upload: { url: upload.url, fields: upload.fields, expiresAt: upload.expiresAt },
    maxBytes: SITE_MAP_MAX_BYTES,
  });
}
