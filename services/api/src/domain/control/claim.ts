/**
 * Helpers of the idempotency claims shared by the command and the lock use cases.
 *
 * A claim is keyed by the identifier the client minted. A replay of the same request (same actor, robot and type)
 * publishes nothing and gets the stored answer; a reuse of the identifier for another request is a conflict (D5).
 *
 * Known window: a crash after the claim is written and before the publish leaves a claim with no command on the wire.
 * A retry with the same identifier then gets `deduplicated: true` and publishes nothing, although the robot never
 * received the command. The console must therefore mint a new identifier for every press and every retry, the e-stop
 * included: a retry is a new request, and a stop that was never sent has to be sent again.
 */
import type { RobotId, SiteId, UserSub, Uuidv7, CommandType } from "@mfc/protocol";
import { COMMAND_IDEMPOTENCY_TTL_SECONDS } from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import type { CommandClaim, ControlDeps } from "./ports";

/**
 * Retention of a claim, in epoch seconds. It outlives the access token, so a captured request cannot be sent again
 * with a valid token after its claim is gone.
 *
 * @param nowSeconds - The current instant in epoch seconds.
 * @returns The expiry of a claim written now.
 */
export function claimExpiry(nowSeconds: number): number {
  return nowSeconds + COMMAND_IDEMPOTENCY_TTL_SECONDS;
}

/**
 * Tells whether a stored claim is the same request as the one being made: same caller, same robot, same type.
 *
 * @param stored - The claim read from the store.
 * @param request - The request being made.
 * @returns True for a replay of the stored request.
 */
export function isSameRequest(
  stored: CommandClaim,
  request: { readonly actor: UserSub; readonly robotId: RobotId; readonly type: CommandType },
): boolean {
  return (
    stored.actor === request.actor &&
    stored.robotId === request.robotId &&
    stored.type === request.type
  );
}

/**
 * Removes the claim of a request that failed before any effect, so that the client can send the same identifier
 * again. Best effort: a failed removal leaves a claim that expires after an hour, and the logs keep the fact.
 *
 * @param deps - The claim port and logger.
 * @param siteId - Site of the request.
 * @param commandId - Identifier of the request.
 */
export async function abandonClaim(
  deps: Pick<ControlDeps, "claims" | "logger">,
  siteId: SiteId,
  commandId: Uuidv7,
): Promise<void> {
  try {
    await deps.claims.abandon(siteId, commandId);
  } catch (error) {
    deps.logger.warn("claim abandon failed", safeErrorFields(error));
  }
}
