/**
 * Listing of the map versions of a site, newest first. Administrators only: the route checks the role.
 */
import {
  MAP_MAX_VERSIONS,
  type MapVersion,
  type MapVersionsResponse,
  type SiteId,
} from "@mfc/protocol";
import type { MapRecord, SiteDeps } from "./ports";
import { succeed, type SiteResult } from "./result";

/**
 * Projects a stored map version onto the public shape. The summary is shown only once the version is
 * validated, and `active` is set for the version the site uses now.
 *
 * @param record - The stored version.
 * @param activeVersion - The version the site uses now, or `null`.
 * @returns The public version.
 */
export function mapVersionOf(record: MapRecord, activeVersion: number | null): MapVersion {
  return {
    version: record.version,
    status: record.status,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    sizeBytes: record.sizeBytes,
    summary: record.summary,
    active: record.version === activeVersion,
  };
}

/**
 * Lists the map versions of a site, newest first, up to the cap.
 *
 * @param deps - The site ports.
 * @param siteId - The site, already checked against the caller's site.
 * @returns The versions, marked with the active one.
 */
export async function listMaps(
  deps: SiteDeps,
  siteId: SiteId,
): Promise<SiteResult<MapVersionsResponse>> {
  const [site, records] = await Promise.all([
    deps.store.getSite(siteId),
    deps.store.listMaps(siteId, MAP_MAX_VERSIONS),
  ]);
  const activeVersion = site?.activeVersion ?? null;
  return succeed({
    versions: records.map((record) => mapVersionOf(record, activeVersion)),
  });
}
