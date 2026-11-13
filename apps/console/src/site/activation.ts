/**
 * Reading of an activation failure. The API answers `409` when the version cannot be activated as it stands
 * (for instance a version that changed under the operator); every other failure reads as generic. The UI maps
 * the result to a fixed message, so no server text reaches the screen.
 */
import { ApiError } from "../api/http-client";

/** The message an activation failure shows: a conflict the operator can resolve, or a generic failure. */
export type ActivationFailureKey = "conflict" | "generic";

/**
 * Classifies an activation failure.
 *
 * @param error - The value the activation rejected with.
 * @returns `conflict` for a `409` answer, `generic` for anything else.
 */
export function activationFailureKey(error: unknown): ActivationFailureKey {
  return error instanceof ApiError && error.status === 409 ? "conflict" : "generic";
}
