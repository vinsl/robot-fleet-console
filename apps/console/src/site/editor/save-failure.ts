/**
 * Converts whatever a save rejected with into the failure the wizard keeps.
 *
 * Every failure the save raises is a {@link SaveMapError}. Anything else is a programming error, which the UI
 * cannot explain; it is reported as `unexpected`, so the operator is told to try again without a detail.
 */
import { SaveMapError, type SaveFailure } from "./save-map";

/**
 * Reads the failure of a rejected save.
 *
 * @param error - The value the save rejected with.
 * @returns The failure to keep in the wizard state.
 */
export function failureOf(error: unknown): SaveFailure {
  if (error instanceof SaveMapError) {
    return error.failure;
  }
  return { stage: "slot", reason: "unexpected", version: null };
}
