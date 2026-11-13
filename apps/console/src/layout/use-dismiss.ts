/**
 * Closes a sheet or panel the way the router was opened: back in history when the view was reached by a
 * navigation, otherwise to the fleet view (a deep link has no earlier entry to return to).
 */
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * Returns the close handler of the current overlay view.
 *
 * @returns A stable function that navigates away from the overlay.
 */
export function useDismiss(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  // React Router gives the first entry of a session the key "default"; any other key means there is a
  // previous entry to go back to.
  const hasPreviousEntry = location.key !== "default";
  return useCallback(() => {
    if (hasPreviousEntry) {
      void navigate(-1);
    } else {
      void navigate("/", { replace: true });
    }
  }, [navigate, hasPreviousEntry]);
}
