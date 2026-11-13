/**
 * The robot view (`/robots/:robotId`): the robot panel inside the side panel. Opening the route directly is the
 * focused mode of the panel (DESIGN 2.2). An identifier that is not a valid robot id shows Not Found.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { RobotIdSchema } from "@mfc/protocol";
import { SidePanel } from "../layout/SidePanel";
import { useDismiss } from "../layout/use-dismiss";
import { RobotPanel } from "../robot/RobotPanel";
import { NotFound } from "./NotFound";

/**
 * Renders the robot panel, or Not Found for an invalid identifier.
 *
 * @returns The panel or the not-found page.
 */
export function RobotPage(): React.JSX.Element {
  const { t } = useTranslation("shell");
  const { robotId } = useParams();
  const dismiss = useDismiss();
  const parsed = RobotIdSchema.safeParse(robotId);
  if (!parsed.success) {
    return <NotFound />;
  }
  return (
    <SidePanel title={t("pages.robot")} onClose={dismiss} expandable>
      <RobotPanel robotId={parsed.data} />
    </SidePanel>
  );
}
