/**
 * Activation of a validated map: the version the site uses from now on.
 *
 * Only a `VALID` version can be activated. The state is checked again inside the write, so a version that changed
 * between the read and the write is refused rather than activated.
 */
import type { Site, SiteId } from "@mfc/protocol";
import { writeSiteAudit } from "./audit";
import { siteOf } from "./get-site";
import type { SiteCall, SiteDeps } from "./ports";
import { SITE_PROBLEMS, refuse, succeed, type SiteResult } from "./result";

/**
 * Makes a validated version the active map of the site. Idempotent: a version that is already active is returned
 * with no write and no audit record.
 *
 * @param deps - The site ports.
 * @param call - The verified caller and the correlation identifier.
 * @param siteId - The site, already checked against the caller's site.
 * @param version - The version number of the request.
 * @returns The site profile, now naming the version; a `404` for an unknown version; a `422` for a version that is
 * not validated.
 */
export async function activateMap(
  deps: SiteDeps,
  call: SiteCall,
  siteId: SiteId,
  version: number,
): Promise<SiteResult<Site>> {
  const record = await deps.store.getMap(siteId, version);
  if (record === null) {
    return refuse(SITE_PROBLEMS.mapNotFound);
  }
  const current = await deps.store.getSite(siteId);
  if (current?.activeVersion === version) {
    return succeed(siteOf(siteId, current));
  }
  if (record.status !== "VALID") {
    return refuse(SITE_PROBLEMS.validateFirst);
  }

  const outcome = await deps.store.activate(siteId, version, deps.clock.now().toISOString());
  if (outcome === "not-valid") {
    return refuse(SITE_PROBLEMS.validateFirst);
  }
  deps.logger.info("site map activated", { version });
  deps.metrics.count("SiteMapActivated");
  await writeSiteAudit(deps, {
    siteId,
    actor: call.actor,
    action: "site.map.activate",
    result: "SUCCEEDED",
    mapVersion: version,
    correlationId: call.correlationId,
  });
  const updated = await deps.store.getSite(siteId);
  return succeed(siteOf(siteId, updated));
}
