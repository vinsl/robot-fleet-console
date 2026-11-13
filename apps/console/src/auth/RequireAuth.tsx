/**
 * Route guard: renders the nested routes only for a signed-in user, and sends everyone else to sign-in.
 */
import type * as React from "react";
import { Navigate, Outlet } from "react-router";
import { useAuthStore } from "./auth-store";

/**
 * Renders the child routes when the user is authenticated, and redirects to `/sign-in` otherwise. When the
 * session ended by expiry, the redirect carries `reason=expired` so that the sign-in view can explain it.
 *
 * @returns The child routes, or a redirect.
 */
export function RequireAuth(): React.JSX.Element {
  const status = useAuthStore((state) => state.status);
  const signOutReason = useAuthStore((state) => state.signOutReason);

  if (status !== "authenticated") {
    const target = signOutReason === "expired" ? "/sign-in?reason=expired" : "/sign-in";
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
