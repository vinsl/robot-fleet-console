/**
 * Chip naming a robot state: the state icon, a small shape glyph and the translated label. The shape and the text
 * carry the state, so it never relies on colour alone (WCAG 1.4.1). Colours, icons and shapes come from
 * `robot-state-visuals.ts`.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type { RobotState } from "@mfc/protocol";
import { classNames } from "../lib/class-names";
import { STATE_VISUALS, type MarkerShape } from "../theme/robot-state-visuals";
import styles from "./StateChip.module.css";

/** Props of {@link StateChip}. */
export interface StateChipProps {
  /** The state to name. */
  readonly state: RobotState;
}

/**
 * CSS class of the glyph for a marker shape. A switch keeps the lookup on the closed shape union.
 *
 * @param shape - The marker shape of the state.
 * @returns The class name of the glyph.
 */
function shapeClassOf(shape: MarkerShape): string | undefined {
  switch (shape) {
    case "circle":
      return styles.circle;
    case "roundedSquare":
      return styles.roundedSquare;
    case "triangle":
      return styles.triangle;
    case "octagon":
      return styles.octagon;
  }
}

/**
 * Renders the state chip. The glyph is decorative: the label next to it is the name.
 *
 * @param props - The state.
 * @returns The chip.
 */
export function StateChip({ state }: StateChipProps): React.JSX.Element {
  const { t } = useTranslation("states");
  // eslint-disable-next-line security/detect-object-injection -- RobotState is a closed protocol enum, the table is keyed by it
  const visual = STATE_VISUALS[state];
  const Icon = visual.icon;
  const filled = visual.fill === "filled";
  return (
    <span className={styles.chip}>
      <span
        aria-hidden="true"
        data-shape={visual.shape}
        className={classNames(
          styles.glyph,
          shapeClassOf(visual.shape),
          visual.fill === "dashed" && styles.dashed,
        )}
        style={filled ? { backgroundColor: visual.color } : { borderColor: visual.color }}
      />
      <Icon
        aria-hidden="true"
        focusable="false"
        className={styles.icon}
        style={{ color: visual.color }}
      />
      <span className={styles.label}>{t(visual.labelKey)}</span>
    </span>
  );
}
