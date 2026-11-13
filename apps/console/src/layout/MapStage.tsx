/**
 * The map area of the "Plan" layout: the live fleet map, with the robots on the tilted plan.
 *
 * The map itself lives in `fleet/map`; this layout slot only gives it its place in the shell. The sign-in page
 * does not use it: without a session there is no site data to request, so it shows the decorative plane.
 */
import type * as React from "react";
import { FleetMap } from "../fleet/map/FleetMap";

/**
 * Renders the fleet map in the layout slot.
 *
 * @returns The fleet map.
 */
export function MapStage(): React.JSX.Element {
  return <FleetMap />;
}
