import { createLucideIcon } from "lucide-react";

/**
 * Articulated robot arm with a two-finger gripper, drawn on Lucide's 24 px grid with 2 px round strokes
 * so it sits with the rest of the icon set. Represents the `WORKING` state (robot handling a load at a
 * station). Original drawing for this project.
 */
export const RobotArmIcon = createLucideIcon("RobotArm", [
  ["path", { d: "M3 21h10", key: "base" }],
  ["path", { d: "M5 21v-1.5a3 3 0 0 1 6 0V21", key: "pedestal" }],
  ["path", { d: "M8.6 16.6 11 8", key: "lower-arm" }],
  ["circle", { cx: "11.5", cy: "6.5", r: "1.5", key: "elbow" }],
  ["path", { d: "m13 6.2 5.5 1.6", key: "upper-arm" }],
  ["path", { d: "M19.5 8v2", key: "wrist" }],
  ["path", { d: "M17 10h5", key: "gripper-bar" }],
  ["path", { d: "M17 10v3l1 1", key: "finger-left" }],
  ["path", { d: "M22 10v3l-1 1", key: "finger-right" }],
]);
