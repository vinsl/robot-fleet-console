/**
 * Read side of the demo mode for the components that only need to know whether it is on.
 *
 * The state is server state shared by every role (the banner depends on it), so it is read from the control API
 * query and refetched on its own schedule.
 */
import { useDemoState } from "../api/control";

/**
 * Tells whether the demo mode of the site is on. Until the first answer arrives, and when the answer cannot be
 * read, the banner stays hidden: a banner must never claim a demo that may not be running.
 *
 * @returns `true` only when the API states that the demo mode is enabled.
 */
export function useDemoEnabled(): boolean {
  return useDemoState().data?.enabled === true;
}
