/**
 * Use case: list the robots of a site, as summaries.
 *
 * Only the summary fields leave the domain (`toSummary`): the certificates, the channel and the provisioning state
 * never reach a response, so a console cannot read a kit reference through the list.
 */
import type { RobotListResponse, SiteId } from "@mfc/protocol";
import { toSummary } from "../robots/registry";
import { succeed, type UseCaseResult } from "../result";
import type { ControlDeps } from "./ports";

/**
 * Lists the robots of a site.
 *
 * @param deps - The registry read port.
 * @param siteId - The verified site of the caller.
 * @returns The summaries, never a refusal: an empty site has an empty list.
 */
export async function listRobots(
  deps: Pick<ControlDeps, "robots">,
  siteId: SiteId,
): Promise<UseCaseResult<RobotListResponse>> {
  const records = await deps.robots.list(siteId);
  return succeed({ robots: records.map(toSummary) });
}
