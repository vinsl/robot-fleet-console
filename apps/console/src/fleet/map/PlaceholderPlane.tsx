/**
 * The decorative plane of the warehouse: a tilted grid with racks and a wall outline, drawn in SVG.
 *
 * It is shown while the real map loads or when there is none, and behind the sign-in form. It carries no data, so
 * it is hidden from assistive technology; the tilt is the same as the live map (`useCompactTilt`).
 */
import type * as React from "react";
import { useCompactTilt } from "./geometry-hooks";
import { map } from "../../theme/tokens";
import styles from "./PlaceholderPlane.module.css";

/** Size of the drawing in SVG user units. The plane scales it to the stage. */
const VIEW_SIZE = 1000;

/** Spacing of the grid lines, in SVG user units. */
const GRID_STEP = 100;

/** Racks drawn on the placeholder plane, as `x y width height` in SVG user units. */
const RACKS: readonly {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}[] = [
  { x: 200, y: 200, w: 300, h: 60 },
  { x: 200, y: 400, w: 300, h: 60 },
  { x: 600, y: 200, w: 200, h: 260 },
];

/** Grid lines covering the drawing, one list of positions per axis. */
const GRID_POSITIONS: readonly number[] = Array.from(
  { length: VIEW_SIZE / GRID_STEP + 1 },
  (_unused, index) => index * GRID_STEP,
);

/**
 * Draws the placeholder grid, racks and wall as an SVG. It fills the plane it is placed in.
 *
 * @returns The drawing, hidden from assistive technology.
 */
export function PlaceholderDrawing(): React.JSX.Element {
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${String(VIEW_SIZE)} ${String(VIEW_SIZE)}`}
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      aria-hidden="true"
    >
      <g className={styles.grid}>
        {GRID_POSITIONS.map((position) => (
          <g key={`grid-${String(position)}`}>
            <line x1={position} y1={0} x2={position} y2={VIEW_SIZE} />
            <line x1={0} y1={position} x2={VIEW_SIZE} y2={position} />
          </g>
        ))}
      </g>
      <g className={styles.racks}>
        {RACKS.map((rack) => (
          <rect
            key={`rack-${String(rack.x)}-${String(rack.y)}`}
            x={rack.x}
            y={rack.y}
            width={rack.w}
            height={rack.h}
          />
        ))}
      </g>
      <rect className={styles.wall} x={100} y={100} width={800} height={800} />
    </svg>
  );
}

/**
 * Renders the decorative plane as a stage of its own, for the places with no live map (the sign-in page).
 *
 * @returns The stage with the tilted plane, hidden from assistive technology.
 */
export function PlaceholderPlane(): React.JSX.Element {
  const compact = useCompactTilt();
  const tiltDeg = compact ? map.tiltCompactDeg : map.tiltDeg;
  return (
    <div className={styles.stage} aria-hidden="true">
      <div className={styles.plane} style={{ transform: `rotateX(${String(tiltDeg)}deg)` }}>
        <PlaceholderDrawing />
      </div>
    </div>
  );
}
