/**
 * Maps the problem types of the agent to the message the operator reads.
 *
 * The agent names each refusal with a `urn:mfc:problem:<suffix>` type. The page shows a sentence per
 * refusal it understands, and a generic one for anything else, so an unknown type never reaches the
 * screen.
 */
import type { MessageKey } from "../i18n";

/** Prefix of every problem type the agent writes. */
const PROBLEM_PREFIX = "urn:mfc:problem:";

/** Message key of each refusal the page knows, by problem suffix. */
const MESSAGE_BY_SUFFIX: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ["claim-used", "claim.used"],
  ["claim-wrong", "claim.wrong"],
  ["claim-expired", "claim.expired"],
  ["claim-locked", "claim.locked"],
  ["credentials-unavailable", "status.credentialsUnavailable"],
  ["unauthorised", "error.unauthorised"],
  ["rate-limited", "error.rateLimited"],
]);

/**
 * Returns the message key of a problem type.
 *
 * @param type - The `type` of the problem, as received.
 * @returns The key of the sentence to show; `error.generic` for any type the page does not know.
 */
export function messageKeyForProblem(type: string): MessageKey {
  if (!type.startsWith(PROBLEM_PREFIX)) {
    return "error.generic";
  }
  const suffix = type.slice(PROBLEM_PREFIX.length);
  return MESSAGE_BY_SUFFIX.get(suffix) ?? "error.generic";
}
