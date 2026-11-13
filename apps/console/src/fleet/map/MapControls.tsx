/**
 * Buttons of the fleet map: zoom in, zoom out, reset the view, and switch between the flat and the tilted view.
 *
 * Each control is a native button with a name. The flat switch is one button whose `aria-pressed` tells the state,
 * so the state is read by a screen reader and seen as a pressed control, not only as a colour.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Layers, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import styles from "./MapControls.module.css";

/** Props of {@link MapControls}. */
export interface MapControlsProps {
  /** Whether the flat view is on. */
  readonly flat: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onReset: () => void;
  readonly onToggleFlat: () => void;
}

/**
 * Renders the map controls, as a group with a name.
 *
 * @param props - The state of the flat view and the actions.
 * @returns The control group.
 */
export function MapControls({
  flat,
  onZoomIn,
  onZoomOut,
  onReset,
  onToggleFlat,
}: MapControlsProps): React.JSX.Element {
  const { t } = useTranslation("fleet");
  return (
    <div role="group" aria-label={t("map.controls")} className={styles.controls}>
      <button
        type="button"
        className={styles.control}
        aria-label={t("map.zoomIn")}
        title={t("map.zoomIn")}
        onClick={onZoomIn}
      >
        <ZoomIn aria-hidden="true" focusable="false" />
      </button>
      <button
        type="button"
        className={styles.control}
        aria-label={t("map.zoomOut")}
        title={t("map.zoomOut")}
        onClick={onZoomOut}
      >
        <ZoomOut aria-hidden="true" focusable="false" />
      </button>
      <button
        type="button"
        className={styles.control}
        aria-label={t("map.reset")}
        title={t("map.reset")}
        onClick={onReset}
      >
        <RotateCcw aria-hidden="true" focusable="false" />
      </button>
      <button
        type="button"
        className={styles.control}
        aria-label={t("map.flat")}
        title={t("map.flat")}
        aria-pressed={flat}
        onClick={onToggleFlat}
      >
        <Layers aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}
