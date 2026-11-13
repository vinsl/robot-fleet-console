/**
 * Presigned download of a validated map version. The download names the object version that was validated, so
 * the file the operator gets is the file that passed validation, even if the key was overwritten since.
 */
import type { MapRef, MapUrlResponse, SiteId } from "@mfc/protocol";
import type { SiteDeps } from "./ports";
import { SITE_PROBLEMS, refuse, succeed, type SiteResult } from "./result";

/**
 * Presigns the download of a map version: the active one when the reference is `active`, otherwise the one
 * named. Only a `VALID` version with its pinned object version can be downloaded; a pending one is not found.
 *
 * @param deps - The site ports.
 * @param siteId - The site, already checked against the caller's site.
 * @param ref - The version number, or `active`.
 * @returns The download, or a `404` when there is no such validated version.
 */
export async function getMapUrl(
  deps: SiteDeps,
  siteId: SiteId,
  ref: MapRef,
): Promise<SiteResult<MapUrlResponse>> {
  const version = await resolveVersion(deps, siteId, ref);
  if (version === null) {
    return refuse(SITE_PROBLEMS.noActiveMap);
  }
  const record = await deps.store.getMap(siteId, version);
  if (
    record === null ||
    record.status !== "VALID" ||
    record.s3VersionId === null ||
    record.sizeBytes === null
  ) {
    return refuse(SITE_PROBLEMS.mapNotFound);
  }
  const download = await deps.objects.presignDownload(record.s3Key, record.s3VersionId, version);
  return succeed({
    version,
    url: download.url,
    expiresAt: download.expiresAt,
    sizeBytes: record.sizeBytes,
  });
}

/**
 * Turns a map reference into a version number.
 *
 * @param deps - The site ports.
 * @param siteId - The site.
 * @param ref - The version number, or `active`.
 * @returns The version, or `null` when the reference is `active` and the site has no active map.
 */
async function resolveVersion(deps: SiteDeps, siteId: SiteId, ref: MapRef): Promise<number | null> {
  if (ref !== "active") {
    return ref;
  }
  const site = await deps.store.getSite(siteId);
  return site?.activeVersion ?? null;
}
