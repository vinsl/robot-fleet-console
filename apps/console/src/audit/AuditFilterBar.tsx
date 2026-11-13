/**
 * The filters of the audit sheet: one robot, and one outcome among the three. The bar only edits the filter value;
 * the sheet decides what a change means for the trail.
 *
 * The outcome is a group of toggle buttons. Each one carries its icon and its text, and the pressed state is shown by
 * the border and the weight as well as by `aria-pressed`, so no state is carried by colour alone.
 */
import { useId, useMemo } from "react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { AuditResultSchema, RobotIdSchema, type AuditResult } from "@mfc/protocol";
import type { AuditFilters } from "../api/audit";
import { useFleetStore } from "../live/fleet-store";
import { auditResultVisual } from "./audit-text";
import styles from "./AuditSheet.module.css";

/** Value of the robot select that means "every robot". An empty string is never a robot identifier. */
const ALL_ROBOTS = "";

/** Props of {@link AuditFilterBar}. */
export interface AuditFilterBarProps {
  /** The filters in force. */
  readonly value: AuditFilters;
  /** Called with the filters after a change. */
  readonly onChange: (next: AuditFilters) => void;
}

/**
 * Renders the filter bar: a robot select, the outcome toggles, and "Clear filters" while a filter is set.
 *
 * @param props - The filters and the change handler.
 * @returns The bar.
 */
export function AuditFilterBar({ value, onChange }: AuditFilterBarProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  const robotSelectId = useId();
  const robots = useFleetStore((state) => state.robots);
  // The robots of the fleet, in a fixed order, so the select does not reshuffle when a frame arrives. The robot that
  // filters now is always listed, so the select never shows "All robots" while a filter is still active.
  const selected = value.robotId;
  const robotIds = useMemo(
    () =>
      [...new Set([...Object.keys(robots), ...(selected === undefined ? [] : [selected])])].sort(),
    [robots, selected],
  );
  const active = value.robotId !== undefined || value.result !== undefined;

  return (
    <fieldset className={styles.filters}>
      <legend className={styles.legend}>{t("filter.legend")}</legend>
      <div className={styles.field}>
        <label htmlFor={robotSelectId}>{t("filter.robot")}</label>
        <select
          id={robotSelectId}
          className={styles.select}
          value={value.robotId ?? ALL_ROBOTS}
          onChange={(event) => {
            // The value comes from the DOM, so it is checked against the identifier schema before it filters anything.
            const parsed = RobotIdSchema.safeParse(event.target.value);
            onChange({ ...value, robotId: parsed.success ? parsed.data : undefined });
          }}
        >
          <option value={ALL_ROBOTS}>{t("filter.allRobots")}</option>
          {robotIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div role="group" aria-label={t("filter.result")} className={styles.toggles}>
        <span className={styles.groupLabel}>{t("filter.result")}</span>
        <ToggleButton
          pressed={value.result === undefined}
          onPress={() => {
            onChange({ ...value, result: undefined });
          }}
        >
          {t("filter.allResults")}
        </ToggleButton>
        {AuditResultSchema.options.map((result) => (
          <ResultToggle
            key={result}
            result={result}
            pressed={value.result === result}
            onPress={() => {
              onChange({ ...value, result });
            }}
          />
        ))}
      </div>
      {active ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            onChange({});
          }}
        >
          {t("filter.clear")}
        </button>
      ) : null}
    </fieldset>
  );
}

/** Props of {@link ToggleButton}. */
interface ToggleButtonProps {
  /** Whether the filter is in force. */
  readonly pressed: boolean;
  /** Called when the button is pressed. */
  readonly onPress: () => void;
  /** The text and the optional icon of the button. */
  readonly children: React.ReactNode;
}

/**
 * A toggle button of the outcome group.
 *
 * @param props - The pressed state, the handler and the content.
 * @returns The button.
 */
function ToggleButton({ pressed, onPress, children }: ToggleButtonProps): React.JSX.Element {
  return (
    <button type="button" aria-pressed={pressed} className={styles.toggle} onClick={onPress}>
      {children}
    </button>
  );
}

/** Props of {@link ResultToggle}. */
interface ResultToggleProps {
  /** The outcome this button filters on. */
  readonly result: AuditResult;
  /** Whether this outcome is the filter in force. */
  readonly pressed: boolean;
  /** Called when the button is pressed. */
  readonly onPress: () => void;
}

/**
 * The toggle of one outcome: its icon and its label, from the same visual as the result chips of the table.
 *
 * @param props - The outcome, the pressed state and the handler.
 * @returns The button.
 */
function ResultToggle({ result, pressed, onPress }: ResultToggleProps): React.JSX.Element {
  const { t } = useTranslation("audit");
  const visual = auditResultVisual(result);
  const Icon = visual.icon;
  return (
    <ToggleButton pressed={pressed} onPress={onPress}>
      <Icon aria-hidden="true" focusable="false" className={styles.icon} />
      <span>{t(visual.labelKey)}</span>
    </ToggleButton>
  );
}
