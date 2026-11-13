/**
 * The graphic of one robot on the fleet map: a shape, a glyph, a halo for alert states and the badges.
 *
 * Shape alone tells the states apart (WCAG 1.4.1): the shape, the fill style and the glyph come from the state
 * visuals, never from this file. The marker is decorative for assistive technology; the button that holds it
 * carries the name of the robot.
 */
import type * as React from "react";
import type { RobotState } from "@mfc/protocol";
import {
  BADGE_VISUALS,
  STATE_VISUALS,
  type BadgeKind,
  type MarkerShape,
} from "../../theme/robot-state-visuals";
import { classNames } from "../../lib/class-names";
import { size } from "../../theme/tokens";
import styles from "./StateMarker.module.css";

/** Props of {@link StateMarker}. */
export interface StateMarkerProps {
  /** The state shown, after the connection rules (see `robotView`). */
  readonly state: RobotState;
  /** Badges stacked above the marker, in display order. */
  readonly badges: readonly BadgeKind[];
  /** Whether the robot is the one open in the side panel. */
  readonly selected: boolean;
  /** `false` at a low zoom: the icon is dropped, the shape and the fill are kept. */
  readonly detail: boolean;
  /** Whether the last frame about the robot is old. Stale markers are faded. */
  readonly stale: boolean;
}

/** Side of the drawing box, in SVG user units. The box is sized by the `--marker` token. */
const BOX = 24;

/** Centre of the drawing box. */
const CENTRE = BOX / 2;

/** Radius of the circle shapes, leaving room for the outline. */
const CIRCLE_RADIUS = 9;

/** Radius of the outer ring of a state (charging, teleop). */
const RING_RADIUS = 11;

/** Size of the glyph icon, in user units, centred in the box. */
const ICON_SIZE = 12;

/** Offset of the icon from the box edge, so that it is centred. */
const ICON_OFFSET = (BOX - ICON_SIZE) / 2;

/**
 * Draws the outline of a state shape.
 *
 * @param props - The shape and the paint of its fill and stroke.
 * @returns The outline element.
 */
function ShapeOutline({
  shape,
  paint,
  dashed,
}: {
  readonly shape: MarkerShape;
  readonly paint: React.CSSProperties;
  readonly dashed: boolean;
}): React.JSX.Element {
  const className = classNames(styles.shape, dashed && styles.dashed);
  switch (shape) {
    case "circle":
      return (
        <circle className={className} style={paint} cx={CENTRE} cy={CENTRE} r={CIRCLE_RADIUS} />
      );
    case "roundedSquare":
      return (
        <rect
          className={className}
          style={paint}
          x={3}
          y={3}
          width={BOX - 6}
          height={BOX - 6}
          rx={4}
        />
      );
    case "triangle":
      return <path className={className} style={paint} d="M12 3 22 20H2Z" />;
    case "octagon":
      return (
        <path className={className} style={paint} d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7Z" />
      );
  }
}

/**
 * Renders one robot marker.
 *
 * The rotation of the icon is driven by the `--heading` custom property, which the marker layer writes on the
 * button every frame. Nothing here holds the heading, so the marker never re-renders for a new heading.
 *
 * @param props - The state, badges, selection, detail and staleness.
 * @returns The marker element, hidden from assistive technology.
 */
export function StateMarker({
  state,
  badges,
  selected,
  detail,
  stale,
}: StateMarkerProps): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- RobotState is a closed union checked by the protocol
  const visual = STATE_VISUALS[state];
  const Icon = visual.icon;
  const filled = visual.fill === "filled";
  const dashed = visual.fill === "dashed";
  // A filled body carries the ink glyph; a hollow or dashed body keeps the state colour for its glyph.
  const bodyPaint: React.CSSProperties = filled
    ? { fill: visual.color, stroke: "var(--ink)" }
    : { fill: "var(--ink)", stroke: visual.color };
  const glyphColor = filled ? "var(--ink)" : visual.color;

  return (
    <span
      className={classNames(styles.marker, stale && styles.stale, selected && styles.selected)}
      data-shape={visual.shape}
      aria-hidden="true"
    >
      {visual.pulse ? <span className={styles.halo} style={{ background: visual.color }} /> : null}
      <svg className={styles.svg} viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} focusable="false">
        <ShapeOutline shape={visual.shape} paint={bodyPaint} dashed={dashed} />
        {visual.outerRing === "none" ? null : (
          <circle
            className={classNames(styles.ring, visual.outerRing === "dashed" && styles.dashed)}
            style={{ stroke: visual.color }}
            cx={CENTRE}
            cy={CENTRE}
            r={RING_RADIUS}
          />
        )}
        {visual.markerGlyph === "icon" && detail ? (
          <g className={visual.showsHeading ? styles.heading : undefined}>
            <Icon
              x={ICON_OFFSET}
              y={ICON_OFFSET}
              width={ICON_SIZE}
              height={ICON_SIZE}
              style={{ color: glyphColor }}
              aria-hidden="true"
              focusable="false"
            />
          </g>
        ) : null}
        {visual.markerGlyph === "dot" ? (
          <circle cx={CENTRE} cy={CENTRE} r={2.5} style={{ fill: visual.color }} />
        ) : null}
        {visual.markerGlyph === "exclamation" ? (
          <g className={styles.exclamation} style={{ stroke: "var(--ink)", fill: "var(--ink)" }}>
            <path d="M12 8.5v5" />
            <circle cx={CENTRE} cy={16.5} r={1} />
          </g>
        ) : null}
      </svg>
      {badges.length === 0 ? null : (
        <span className={styles.badges}>
          {badges.map((kind) => {
            // eslint-disable-next-line security/detect-object-injection -- BadgeKind is a closed union defined in code
            const badge = BADGE_VISUALS[kind];
            const BadgeIcon = badge.icon;
            return (
              <span key={kind} className={styles.badge} style={{ color: badge.color }}>
                <BadgeIcon size={size.badge} aria-hidden="true" focusable="false" />
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
