/**
 * Update of the site profile: the name. Administrators only; the route checks the role.
 */
import type { Site, SiteId, UpdateSiteRequest } from "@mfc/protocol";
import { writeSiteAudit } from "./audit";
import { siteOf } from "./get-site";
import type { SiteCall, SiteDeps } from "./ports";
import { succeed, type SiteResult } from "./result";

/**
 * Stores the name of a site and audits the change. The profile returned is read back after the write, so the
 * response shows what is stored. The store creates the profile when it is absent on purpose: a site can be named
 * before its first map upload.
 *
 * @param deps - The site ports.
 * @param call - The verified caller and the correlation identifier.
 * @param siteId - The site, already checked against the caller's site.
 * @param request - The validated new name.
 * @returns The stored profile. Never a refusal.
 */
export async function updateSite(
  deps: SiteDeps,
  call: SiteCall,
  siteId: SiteId,
  request: UpdateSiteRequest,
): Promise<SiteResult<Site>> {
  await deps.store.putName(siteId, request.name, deps.clock.now().toISOString());
  await writeSiteAudit(deps, {
    siteId,
    actor: call.actor,
    action: "site.update",
    result: "SUCCEEDED",
    correlationId: call.correlationId,
  });
  const record = await deps.store.getSite(siteId);
  return succeed(siteOf(siteId, record));
}
