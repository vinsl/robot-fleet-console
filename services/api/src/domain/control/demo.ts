/**
 * Use cases of the demo mode of a site: read the flag, and switch it.
 *
 * The flag is the switch that lets the fault injection reach the simulated robots (D17). Switching it is an
 * Admin action, and every switch is audited with its direction.
 */
import type { DemoState, DemoUpdateRequest, SiteId } from "@mfc/protocol";
import type { Principal } from "../authz";
import { succeed, type UseCaseResult } from "../result";
import { writeControlAudit } from "./audit";
import type { ControlCall, ControlDeps } from "./ports";

/**
 * Reads the demo flag of a site. An absent flag reads as disabled.
 *
 * @param deps - The demo store.
 * @param siteId - The verified site of the caller.
 * @returns The flag.
 */
export async function getDemo(
  deps: Pick<ControlDeps, "demo">,
  siteId: SiteId,
): Promise<UseCaseResult<DemoState>> {
  return succeed(await deps.demo.get(siteId));
}

/**
 * Switches the demo flag of a site and audits the switch.
 *
 * @param deps - The control dependencies.
 * @param principal - The verified caller, an Admin by the route matrix.
 * @param siteId - The verified site of the caller.
 * @param request - The validated body.
 * @param call - The verified caller's correlation identifier.
 * @returns The flag as stored.
 */
export async function setDemo(
  deps: ControlDeps,
  principal: Principal,
  siteId: SiteId,
  request: DemoUpdateRequest,
  call: ControlCall,
): Promise<UseCaseResult<DemoState>> {
  const state = await deps.demo.set(siteId, {
    enabled: request.enabled,
    changedBy: principal.userId,
    changedAt: deps.clock.now().toISOString(),
  });
  deps.metrics.count("DemoToggled");
  await writeControlAudit(deps, {
    siteId,
    actor: principal.userId,
    action: request.enabled ? "demo.enable" : "demo.disable",
    result: "SUCCEEDED",
    correlationId: call.correlationId,
  });
  return succeed(state);
}
