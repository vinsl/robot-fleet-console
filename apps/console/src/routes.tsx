/**
 * Route table of the console.
 *
 * Every view except sign-in sits behind {@link RequireAuth} and inside the {@link Shell} layout. Site and user
 * administration are also behind {@link RequireRole} for Admins only. These guards only shape the UI: the API
 * enforces the same rules.
 */
import { createBrowserRouter } from "react-router";
import { AlertsSheet } from "./alerts/AlertsSheet";
import { AuditSheet } from "./audit/AuditSheet";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireRole } from "./auth/RequireRole";
import { RobotsSheet } from "./fleet/robots/RobotsSheet";
import { KpiSheet } from "./kpi/KpiSheet";
import { Shell } from "./layout/Shell";
import { NotFound } from "./pages/NotFound";
import { RobotPage } from "./pages/RobotPage";
import { SitePage } from "./pages/SitePage";
import { SignIn } from "./pages/SignIn";

/**
 * Creates the browser router of the console.
 *
 * The fleet view (index) renders nothing in the stage: the map is the view. Other views render over it.
 *
 * @returns The router. Create it once per page.
 */
export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter([
    { path: "/sign-in", element: <SignIn /> },
    {
      element: <RequireAuth />,
      children: [
        {
          element: <Shell />,
          children: [
            { index: true },
            { path: "robots", element: <RobotsSheet /> },
            { path: "robots/:robotId", element: <RobotPage /> },
            { path: "alerts", element: <AlertsSheet /> },
            { path: "audit", element: <AuditSheet /> },
            { path: "kpi", element: <KpiSheet /> },
            {
              path: "site",
              element: (
                <RequireRole allowed={["Admin"]}>
                  <SitePage />
                </RequireRole>
              ),
            },
          ],
        },
      ],
    },
    { path: "*", element: <NotFound /> },
  ]);
}
