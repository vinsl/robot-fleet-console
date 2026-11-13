/**
 * Drawing of a site plan as an SVG: walls, obstacles, no-go zones, the charger and the workstations.
 *
 * Every feature is drawn with a shape and a text label, never colour alone: the no-go zone is hatched and dashed,
 * the charger is a bolt, a workstation is a square with its name. The plan is flipped once, in a single group, so
 * site coordinates (`y` up) read correctly; text and icons are flipped back inside that group.
 *
 * The component takes grouped features rather than a validated map, so the editor can draw a draft that does not
 * yet satisfy the protocol (no charger, for instance).
 */
import type * as React from "react";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import type { Point } from "../dxf/types";
import { lineToPath, ringToPath } from "../svg-paths";
import {
  CHARGER_LABEL_OFFSET_UNITS,
  HATCH_STROKE_UNITS,
  LABEL_HALO_UNITS,
  LABEL_SIZE_UNITS,
  markerUnit,
  mapViewBox,
  stationLabelOffset,
  type FeatureLayers,
} from "./map-geometry";
import styles from "./SiteMapView.module.css";

/** Props of {@link SiteMapView}. */
export interface SiteMapViewProps {
  /** The features to draw, grouped by kind. */
  readonly layers: FeatureLayers;
  /** Accessible name of the drawing, written by the caller for the place it is shown in. */
  readonly label: string;
  /** Overlay drawn above the plan, in site coordinates (inside the flipped group). The editor places its handles here. */
  readonly children?: React.ReactNode;
}

/**
 * Renders a site plan as an SVG, with an optional overlay.
 *
 * A read-only plan is one image. With an overlay the plan holds controls (the editor's features), and an image
 * would hide them from assistive technology, so it is a group that contains them.
 *
 * @param props - The features, the accessible name and the overlay.
 * @returns The image, or the group when there is an overlay.
 */
export function SiteMapView({ layers, label, children }: SiteMapViewProps): React.JSX.Element {
  const { t } = useTranslation("site");
  // The id must be a plain token to be used in `url(#...)`; React ids contain colons.
  const idBase = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const hatchId = `${idBase}-hatch`;
  const view = useMemo(() => mapViewBox(layers), [layers]);
  const unit = useMemo(() => markerUnit(layers), [layers]);

  return (
    <svg
      role={children === undefined ? "img" : "group"}
      aria-label={label}
      viewBox={`${String(view.minX)} ${String(view.minY)} ${String(view.width)} ${String(view.height)}`}
      className={styles.map}
    >
      <defs>
        <pattern
          id={hatchId}
          width={unit}
          height={unit}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={unit}
            strokeWidth={unit * HATCH_STROKE_UNITS}
            className={styles.hatch}
          />
        </pattern>
      </defs>
      <g transform="scale(1 -1)">
        {layers.walls.map((points, index) => (
          <path
            // Walls have no identity in the file; their order is fixed for a given map, so the index is a stable key.
            key={`wall-${String(index)}`}
            d={lineToPath(points)}
            className={styles.wall}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {layers.obstacles.map((ring, index) => (
          <path
            // Obstacles have no identity in the file; their order is fixed for a given map, so the index is a stable key.
            key={`obstacle-${String(index)}`}
            d={ringToPath(ring)}
            className={styles.rack}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {layers.nogo.map((ring, index) => (
          <path
            // No-go zones have no identity in the file; their order is fixed for a given map, so the index is a stable key.
            key={`nogo-${String(index)}`}
            d={ringToPath(ring)}
            fill={`url(#${hatchId})`}
            className={styles.nogoArea}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {layers.charger === null ? null : (
          <ChargerMark at={layers.charger} unit={unit} label={t("map.legend.charger")} />
        )}
        {layers.workstations.map((workstation, index) => (
          // Names are unique in a validated plan, but a draft can repeat one; the index keeps keys unique.
          <g key={`workstation-${String(index)}`}>
            {workstation.size === null ? null : (
              <rect
                x={workstation.at[0] - workstation.size.width / 2}
                y={workstation.at[1] - workstation.size.height / 2}
                width={workstation.size.width}
                height={workstation.size.height}
                className={styles.stationArea}
                vectorEffect="non-scaling-stroke"
              />
            )}
            <rect
              x={workstation.at[0] - unit / 2}
              y={workstation.at[1] - unit / 2}
              width={unit}
              height={unit}
              className={styles.station}
            />
            <text
              transform={labelTransform(
                workstation.at,
                -stationLabelOffset(unit, workstation.size),
              )}
              fontSize={unit * LABEL_SIZE_UNITS}
              strokeWidth={unit * LABEL_HALO_UNITS}
              textAnchor="middle"
              className={styles.label}
            >
              {workstation.name}
            </text>
          </g>
        ))}
        {children}
      </g>
    </svg>
  );
}

/**
 * Places a label of the flipped plan so that its text reads upright and its baseline sits at the given offset from
 * the anchor. The text is flipped back about its own anchor, so the glyphs are not mirrored.
 *
 * @param anchor - The position of the feature, in site coordinates.
 * @param dy - Vertical offset from the anchor, in site coordinates; negative places the label below the feature.
 * @returns The `transform` attribute value.
 */
function labelTransform(anchor: Point, dy: number): string {
  return `translate(${String(anchor[0])} ${String(anchor[1] + dy)}) scale(1 -1)`;
}

/** Props of {@link ChargerMark}. */
interface ChargerMarkProps {
  /** Position of the charger, in site coordinates. */
  readonly at: Point;
  /** Size of one marker unit, in site metres. */
  readonly unit: number;
  /** Translated name of the charger, shown under the bolt. */
  readonly label: string;
}

/**
 * The charger: a bolt icon and its name. The icon sits in two nested flips, so that it is drawn upright inside the
 * flipped plan.
 *
 * @param props - Position, size and label.
 * @returns The bolt and its label.
 */
function ChargerMark({ at, unit, label }: ChargerMarkProps): React.JSX.Element {
  return (
    <g>
      <g transform={`translate(${String(at[0])} ${String(at[1])}) scale(1 -1)`}>
        <g transform="scale(1 -1)">
          <Zap
            x={-unit}
            y={-unit}
            width={2 * unit}
            height={2 * unit}
            className={styles.charger}
            aria-hidden="true"
            focusable="false"
          />
        </g>
      </g>
      <text
        transform={labelTransform(at, -CHARGER_LABEL_OFFSET_UNITS * unit)}
        fontSize={unit * LABEL_SIZE_UNITS}
        strokeWidth={unit * LABEL_HALO_UNITS}
        textAnchor="middle"
        className={styles.label}
      >
        {label}
      </text>
    </g>
  );
}
