/**
 * Read of the site profile. A site with no item yet is still a site: its profile is the default one, and
 * reading it writes nothing.
 */
import type { Site, SiteId } from "@mfc/protocol";
import { succeed, type SiteResult } from "./result";
import type { SiteDeps, SiteRecord } from "./ports";

/**
 * Builds the public profile of a site from its stored record.
 *
 * A site created by its first map upload has no name yet; its id then stands in for the name, which is the
 * same default an unnamed site shows.
 *
 * @param siteId - The site.
 * @param record - The stored record, or `null` when the site has no item.
 * @returns The profile to return.
 */
export function siteOf(siteId: SiteId, record: SiteRecord | null): Site {
  return {
    siteId,
    name: record?.name ?? siteId,
    activeVersion: record?.activeVersion ?? null,
    updatedAt: record?.updatedAt ?? null,
  };
}

/**
 * Reads the profile of a site.
 *
 * @param deps - The site ports.
 * @param siteId - The site, already checked against the caller's site.
 * @returns The profile. Never a refusal.
 */
export async function getSite(deps: SiteDeps, siteId: SiteId): Promise<SiteResult<Site>> {
  const record = await deps.store.getSite(siteId);
  return succeed(siteOf(siteId, record));
}
