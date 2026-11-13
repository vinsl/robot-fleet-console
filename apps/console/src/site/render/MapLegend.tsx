/**
 * Legend of the site map: one entry per feature kind, with the same shape as on the drawing and its name as text.
 * The shape and the text carry the meaning; the colour only adds to them.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { classNames } from "../../lib/class-names";
import styles from "./SiteMapView.module.css";

/** Feature kinds of the legend, in the order a reader meets them. */
const LEGEND_KINDS = ["wall", "obstacle", "nogo", "charger", "workstation"] as const;

/** A kind shown in the legend. */
type LegendKind = (typeof LEGEND_KINDS)[number];

/** Drawing box of a legend icon. The shapes below are laid out in it. */
const ICON_VIEW_BOX = "0 0 24 24";

/**
 * The swatch of one kind: the same shape and classes as the drawing, at legend size.
 *
 * @param props - The kind to draw.
 * @returns A decorative SVG; the entry's text names it.
 */
function LegendSwatch({ kind }: { readonly kind: LegendKind }): React.JSX.Element {
  switch (kind) {
    case "wall":
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={ICON_VIEW_BOX}
          className={styles.legendIcon}
        >
          <line x1={2} y1={12} x2={22} y2={12} className={styles.wall} />
        </svg>
      );
    case "obstacle":
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={ICON_VIEW_BOX}
          className={styles.legendIcon}
        >
          <rect x={3} y={5} width={18} height={14} className={styles.rack} />
        </svg>
      );
    case "nogo":
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={ICON_VIEW_BOX}
          className={styles.legendIcon}
        >
          <rect
            x={3}
            y={5}
            width={18}
            height={14}
            className={classNames(styles.nogoSwatch, styles.nogoArea)}
          />
        </svg>
      );
    case "charger":
      return (
        <Zap
          aria-hidden="true"
          focusable="false"
          className={classNames(styles.legendIcon, styles.charger)}
        />
      );
    case "workstation":
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={ICON_VIEW_BOX}
          className={styles.legendIcon}
        >
          <rect x={6} y={6} width={12} height={12} className={styles.station} />
        </svg>
      );
  }
}

/**
 * Renders the legend of the site map.
 *
 * @returns A list with one entry per feature kind.
 */
export function MapLegend(): React.JSX.Element {
  const { t } = useTranslation("site");
  return (
    <ul aria-label={t("map.legendLabel")} className={styles.legend}>
      {LEGEND_KINDS.map((kind) => (
        <li key={kind} className={styles.legendItem}>
          <LegendSwatch kind={kind} />
          <span>{t(`map.legend.${kind}`)}</span>
        </li>
      ))}
    </ul>
  );
}
