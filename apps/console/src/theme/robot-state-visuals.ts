/**
 * Visual language of robot states, badges, alerts, command results and connection status, as validated
 * on 2026-10-30 (`docs/design/DESIGN.md` §3). Components read this table; they never pick a colour, icon
 * or shape themselves.
 *
 * Colours reference `tokens.ts`; labels are i18n keys in the `states` namespace (`en` and `fr`).
 *
 * @module theme/robot-state-visuals
 */
import {
  BatteryCharging,
  BatteryLow,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock,
  EyeOff,
  FlaskConical,
  Hand,
  Info,
  LoaderCircle,
  Lock,
  type LucideIcon,
  Navigation2,
  OctagonX,
  Pause,
  Radio,
  RefreshCw,
  TriangleAlert,
  User,
  Video,
  Volume2,
  VolumeOff,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import type { AuditResult, RobotState } from "@mfc/protocol";

import { RobotArmIcon } from "../components/icons/RobotArmIcon";
import { color } from "./tokens";

/** Outline of a map marker. Shape alone must distinguish states without colour (WCAG 1.4.1). */
export type MarkerShape = "circle" | "roundedSquare" | "triangle" | "octagon";

/** How the shape is painted: filled with the state colour, or outlined (solid or dashed). */
export type MarkerFill = "filled" | "hollow" | "dashed";

/** Alert severity, aligned with FR-ALR-1. */
export type AlertSeverity = "critical" | "major" | "minor" | "info";

/** Everything needed to draw one robot state on the map, in a chip and in lists. */
export interface StateVisual {
  /** i18n key, namespace `states`. */
  readonly labelKey: string;
  readonly color: string;
  readonly shape: MarkerShape;
  readonly fill: MarkerFill;
  /** Icon in chips and lists. */
  readonly icon: LucideIcon;
  /**
   * What the marker draws inside its shape. `icon` reuses `icon`; `dot` draws a centre dot (IDLE);
   * `exclamation` draws a "!" glyph that fits the triangle (BLOCKED).
   */
  readonly markerGlyph: "icon" | "dot" | "exclamation";
  /** Rotate the marker icon and show the heading arrow. */
  readonly showsHeading: boolean;
  readonly outerRing: "none" | "solid" | "dashed";
  readonly pulse: boolean;
  /** Severity of the alert this state raises, if any (FR-ALR-1). */
  readonly raisesAlert: AlertSeverity | null;
}

/** Visual definition of every robot state; the type forces one entry per `RobotState`. */
export const STATE_VISUALS = {
  MOVING: {
    labelKey: "state.moving",
    color: color.state.nominal,
    shape: "circle",
    fill: "filled",
    icon: Navigation2,
    markerGlyph: "icon",
    showsHeading: true,
    outerRing: "none",
    pulse: false,
    raisesAlert: null,
  },
  WORKING: {
    labelKey: "state.working",
    color: color.state.nominal,
    shape: "roundedSquare",
    fill: "filled",
    icon: RobotArmIcon,
    markerGlyph: "icon",
    showsHeading: false,
    outerRing: "none",
    pulse: false,
    raisesAlert: null,
  },
  IDLE: {
    labelKey: "state.idle",
    color: color.state.idle,
    shape: "circle",
    fill: "hollow",
    icon: CircleDot,
    markerGlyph: "dot",
    showsHeading: false,
    outerRing: "none",
    pulse: false,
    raisesAlert: null,
  },
  CHARGING: {
    labelKey: "state.charging",
    color: color.state.charging,
    shape: "circle",
    fill: "filled",
    icon: BatteryCharging,
    markerGlyph: "icon",
    showsHeading: false,
    outerRing: "solid",
    pulse: false,
    raisesAlert: null,
  },
  PAUSED: {
    labelKey: "state.paused",
    color: color.state.human,
    shape: "circle",
    fill: "hollow",
    icon: Pause,
    markerGlyph: "icon",
    showsHeading: false,
    outerRing: "none",
    pulse: false,
    raisesAlert: null,
  },
  TELEOP: {
    labelKey: "state.teleop",
    color: color.state.human,
    shape: "circle",
    fill: "filled",
    icon: Hand,
    markerGlyph: "icon",
    showsHeading: true,
    outerRing: "dashed",
    pulse: false,
    raisesAlert: null,
  },
  BLOCKED: {
    labelKey: "state.blocked",
    color: color.state.blocked,
    shape: "triangle",
    fill: "filled",
    icon: TriangleAlert,
    markerGlyph: "exclamation",
    showsHeading: false,
    outerRing: "none",
    pulse: true,
    raisesAlert: "major",
  },
  ESTOP: {
    labelKey: "state.estop",
    color: color.state.estop,
    shape: "octagon",
    fill: "filled",
    icon: OctagonX,
    markerGlyph: "icon",
    showsHeading: false,
    outerRing: "none",
    pulse: true,
    raisesAlert: "critical",
  },
  OFFLINE: {
    labelKey: "state.offline",
    color: color.state.offline,
    shape: "circle",
    fill: "dashed",
    icon: WifiOff,
    markerGlyph: "icon",
    showsHeading: false,
    outerRing: "none",
    pulse: false,
    raisesAlert: "major",
  },
} as const satisfies Record<RobotState, StateVisual>;

/** Badges added on top of a state, stacked upwards from the top-right of the marker. */
export type BadgeKind =
  "lowBattery" | "sensorFault" | "lockMine" | "lockOther" | "camera" | "stale" | "simulated";

/** Everything needed to draw one badge: label key, colour and icon. */
export interface BadgeVisual {
  readonly labelKey: string;
  readonly color: string;
  readonly icon: LucideIcon;
}

/** Badge table, keyed by kind. */
export const BADGE_VISUALS = {
  lowBattery: { labelKey: "badge.lowBattery", color: color.state.blocked, icon: BatteryLow },
  sensorFault: { labelKey: "badge.sensorFault", color: color.state.estop, icon: EyeOff },
  lockMine: { labelKey: "badge.lockMine", color: color.state.human, icon: Lock },
  lockOther: { labelKey: "badge.lockOther", color: color.text.secondary, icon: User },
  camera: { labelKey: "badge.camera", color: color.text.primary, icon: Video },
  stale: { labelKey: "badge.stale", color: color.text.secondary, icon: Clock },
  simulated: { labelKey: "badge.simulated", color: color.text.secondary, icon: FlaskConical },
} as const satisfies Record<BadgeKind, BadgeVisual>;

/** Fixed display order when several badges apply. */
export const BADGE_ORDER: readonly BadgeKind[] = [
  "sensorFault",
  "lowBattery",
  "lockMine",
  "lockOther",
  "camera",
  "stale",
  "simulated",
];

/** Alert severity table (FR-ALR-1): label key, colour and icon per severity. */
export const ALERT_VISUALS = {
  critical: {
    labelKey: "alert.critical",
    color: color.alert.critical,
    icon: OctagonX,
    sound: "repeat",
  },
  major: { labelKey: "alert.major", color: color.alert.major, icon: TriangleAlert, sound: "once" },
  minor: { labelKey: "alert.minor", color: color.alert.minor, icon: CircleAlert, sound: "none" },
  info: { labelKey: "alert.info", color: color.alert.info, icon: Info, sound: "none" },
} as const satisfies Record<
  AlertSeverity,
  { labelKey: string; color: string; icon: LucideIcon; sound: "repeat" | "once" | "none" }
>;

/** Resolved alerts lose their severity colour. */
export const ALERT_RESOLVED_VISUAL = {
  labelKey: "alert.resolved",
  color: color.alert.resolved,
  icon: CircleCheck,
} as const;

/** Command status shown in the robot panel (FR-CMD-5). */
export const COMMAND_VISUALS = {
  pending: { labelKey: "command.pending", color: color.text.secondary, icon: LoaderCircle },
  ack: { labelKey: "command.ack", color: color.state.charging, icon: Check },
  reject: { labelKey: "command.reject", color: color.state.estop, icon: X },
} as const satisfies Record<string, { labelKey: string; color: string; icon: LucideIcon }>;

/**
 * Outcome of an audited action in the audit sheet. Labels live in the `audit` namespace, named explicitly so the
 * table can be read from any namespace. A refusal reuses the command reject visual; a failure is a warning, not
 * a success, so it gets the blocked colour and its own icon. Icon and text carry the meaning, never the colour.
 */
export const AUDIT_RESULT_VISUALS = {
  SUCCEEDED: { labelKey: "audit:result.SUCCEEDED", color: color.state.charging, icon: Check },
  REFUSED: { labelKey: "audit:result.REFUSED", color: color.state.estop, icon: X },
  FAILED: { labelKey: "audit:result.FAILED", color: color.state.blocked, icon: TriangleAlert },
} as const satisfies Record<AuditResult, { labelKey: string; color: string; icon: LucideIcon }>;

/** Real-time link status in the status line (NFR-REL-1). */
export const CONNECTION_VISUALS = {
  live: { labelKey: "connection.live", color: color.state.charging, icon: Radio },
  reconnecting: {
    labelKey: "connection.reconnecting",
    color: color.state.blocked,
    icon: RefreshCw,
  },
  offline: { labelKey: "connection.offline", color: color.state.estop, icon: WifiOff },
} as const satisfies Record<string, { labelKey: string; color: string; icon: LucideIcon }>;

/** States of the alert sound toggle in the status line (ADR 0060). Labels are in the `alerts` namespace. */
export type SoundState = "on" | "muted" | "blocked";

/** Visual of the alert sound toggle: on, muted, or blocked by the browser until the user clicks. */
export const SOUND_VISUALS = {
  on: { labelKey: "sound.on", color: color.text.primary, icon: Volume2 },
  muted: { labelKey: "sound.muted", color: color.text.secondary, icon: VolumeX },
  blocked: { labelKey: "sound.blocked", color: color.alert.major, icon: VolumeOff },
} as const satisfies Record<SoundState, { labelKey: string; color: string; icon: LucideIcon }>;
