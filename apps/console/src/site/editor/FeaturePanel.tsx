/**
 * The feature panel: every placed feature as a row of exact values, with buttons to add and remove them. It is the
 * keyboard and screen-reader path of the editor; the canvas gives the same actions to a pointer.
 *
 * Numbers are typed in metres, in the site frame. A field that does not hold a number changes nothing, so the
 * plan is never moved to a value the operator did not finish typing.
 */
import type * as React from "react";
import { useState, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import {
  SITE_MAP_NAME_PATTERN,
  WORKSTATION_SIZE_MAX_M,
  WORKSTATION_SIZE_MIN_M,
} from "@mfc/protocol";
import type { EditorFeatures, Imported, Rect } from "../dxf/build-site-map";
import { usableSide, type FeatureRef } from "./draft";
import { classNames } from "../../lib/class-names";
import { snap } from "./coords";
import type { WizardAction } from "./wizard-reducer";
import styles from "./Editor.module.css";

/** Side of a new no-go zone, in metres, centred on the middle of the plan. */
const NEW_NOGO_SIDE_M = 2;

/** Props of {@link FeaturePanel}. */
export interface FeaturePanelProps {
  /** The imported plan, for its extent. */
  readonly imported: Imported;
  /** The features placed so far. */
  readonly editor: EditorFeatures;
  /** The selected feature, if any. Its row is marked. */
  readonly selection: FeatureRef | null;
  /** Sends the changes to the wizard. */
  readonly dispatch: Dispatch<WizardAction>;
}

/** Props of {@link NumberField}. */
interface NumberFieldProps {
  /** Visible label, which is also the accessible name. */
  readonly label: string;
  /** Current value, in metres. */
  readonly value: number;
  /** Called with a finite value the operator typed. */
  readonly onCommit: (value: number) => void;
  /** Whether the value is out of range, which marks the field as invalid for assistive technology. */
  readonly invalid?: boolean;
  /** Id of the element that explains the field, when it is invalid. */
  readonly describedBy?: string;
}

/**
 * A numeric field in metres. The text is kept while the operator types, so a field can be cleared and retyped; an
 * empty or partial entry is not committed. A value that changes from outside (a key press, a drag) replaces the
 * text.
 *
 * @param props - The label, value, commit callback and validity.
 * @returns The labelled field.
 */
function NumberField({
  label,
  value,
  onCommit,
  invalid,
  describedBy,
}: NumberFieldProps): React.JSX.Element {
  const [text, setText] = useState(String(value));
  // The last value this field knows about. Comparing with it tells an outside change from the one just typed.
  const [known, setKnown] = useState(value);
  if (value !== known) {
    setKnown(value);
    setText(String(value));
  }
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        step="0.1"
        inputMode="decimal"
        className={styles.input}
        value={text}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={invalid === true ? describedBy : undefined}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const next = event.currentTarget.valueAsNumber;
          setText(raw);
          if (raw !== "" && Number.isFinite(next)) {
            setKnown(next);
            onCommit(next);
          }
        }}
      />
    </label>
  );
}

/**
 * Renders the feature panel.
 *
 * @param props - The plan, the features, the selection and the dispatcher.
 * @returns The panel.
 */
export function FeaturePanel({
  imported,
  editor,
  selection,
  dispatch,
}: FeaturePanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation("site");
  // The decimal separator follows the language, as in the plan's labels.
  const numbers = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const centre = snap([imported.extent[0] / 2, imported.extent[1] / 2]);
  const isSelected = (target: FeatureRef): boolean =>
    selection !== null &&
    selection.kind === target.kind &&
    (target.kind === "charger" ||
      (selection.kind !== "charger" && selection.index === target.index));
  const empty =
    editor.charger === null && editor.workstations.length === 0 && editor.nogo.length === 0;

  /**
   * Adds a no-go zone in the middle of the plan.
   */
  const addNogo = (): void => {
    const rect: Rect = {
      x: centre[0] - NEW_NOGO_SIDE_M / 2,
      y: centre[1] - NEW_NOGO_SIDE_M / 2,
      w: NEW_NOGO_SIDE_M,
      h: NEW_NOGO_SIDE_M,
    };
    dispatch({ type: "addNogo", rect });
  };

  return (
    <section aria-labelledby="site-panel-title" className={styles.panel}>
      <h4 id="site-panel-title" className={styles.panelTitle}>
        {t("edit.panel.title")}
      </h4>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            dispatch({ type: "placeCharger", at: centre });
          }}
        >
          {t("edit.panel.addCharger")}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            dispatch({ type: "addWorkstation", at: centre });
          }}
        >
          {t("edit.panel.addWorkstation")}
        </button>
        <button type="button" className={styles.button} onClick={addNogo}>
          {t("edit.panel.addNogo")}
        </button>
      </div>

      <p className={styles.hint}>{t("edit.resizeHint")}</p>

      {empty ? <p className={styles.hint}>{t("edit.panel.empty")}</p> : null}

      {editor.charger === null ? null : (
        <div
          className={classNames(styles.row, isSelected({ kind: "charger" }) && styles.rowSelected)}
        >
          <span className={styles.rowTitle}>{t("edit.panel.charger")}</span>
          <NumberField
            label={t("edit.panel.x")}
            value={editor.charger[0]}
            onCommit={(x) => {
              dispatch({ type: "placeCharger", at: [x, editor.charger?.[1] ?? 0] });
            }}
          />
          <NumberField
            label={t("edit.panel.y")}
            value={editor.charger[1]}
            onCommit={(y) => {
              dispatch({ type: "placeCharger", at: [editor.charger?.[0] ?? 0, y] });
            }}
          />
          <RemoveButton
            label={t("edit.panel.charger")}
            onRemove={() => {
              dispatch({ type: "remove", target: { kind: "charger" } });
            }}
          />
        </div>
      )}

      {editor.workstations.map((workstation, index) => {
        const label = t("edit.panel.workstation", { number: index + 1 });
        const errorId = `workstation-size-error-${String(index)}`;
        const widthValid = usableSide(workstation.size.width);
        const heightValid = usableSide(workstation.size.height);
        return (
          <div
            key={`workstation-row-${String(index)}`}
            className={classNames(
              styles.row,
              isSelected({ kind: "workstation", index }) && styles.rowSelected,
            )}
          >
            <span className={styles.rowTitle}>{label}</span>
            <label className={styles.field}>
              <span>{t("edit.panel.name")}</span>
              <input
                type="text"
                className={styles.input}
                value={workstation.name}
                aria-invalid={!SITE_MAP_NAME_PATTERN.test(workstation.name)}
                onChange={(event) => {
                  dispatch({
                    type: "renameWorkstation",
                    index,
                    name: event.currentTarget.value,
                  });
                }}
              />
            </label>
            <NumberField
              label={t("edit.panel.x")}
              value={workstation.at[0]}
              onCommit={(x) => {
                dispatch({ type: "setWorkstationAt", index, at: [x, workstation.at[1]] });
              }}
            />
            <NumberField
              label={t("edit.panel.y")}
              value={workstation.at[1]}
              onCommit={(y) => {
                dispatch({ type: "setWorkstationAt", index, at: [workstation.at[0], y] });
              }}
            />
            <NumberField
              label={t("edit.panel.w")}
              value={workstation.size.width}
              invalid={!widthValid}
              describedBy={errorId}
              onCommit={(width) => {
                dispatch({
                  type: "setWorkstationSize",
                  index,
                  size: { width, height: workstation.size.height },
                });
              }}
            />
            <NumberField
              label={t("edit.panel.h")}
              value={workstation.size.height}
              invalid={!heightValid}
              describedBy={errorId}
              onCommit={(height) => {
                dispatch({
                  type: "setWorkstationSize",
                  index,
                  size: { width: workstation.size.width, height },
                });
              }}
            />
            {widthValid && heightValid ? null : (
              <p id={errorId} className={styles.rowError}>
                {t("edit.panel.sizeRange", {
                  min: numbers.format(WORKSTATION_SIZE_MIN_M),
                  max: numbers.format(WORKSTATION_SIZE_MAX_M),
                })}
              </p>
            )}
            <RemoveButton
              label={label}
              onRemove={() => {
                dispatch({ type: "remove", target: { kind: "workstation", index } });
              }}
            />
          </div>
        );
      })}

      {editor.nogo.map((rect, index) => {
        const label = t("edit.panel.nogo", { number: index + 1 });
        const update = (next: Rect): void => {
          dispatch({ type: "updateNogo", index, rect: next });
        };
        return (
          <div
            key={`nogo-row-${String(index)}`}
            className={classNames(
              styles.row,
              isSelected({ kind: "nogo", index }) && styles.rowSelected,
            )}
          >
            <span className={styles.rowTitle}>{label}</span>
            <NumberField
              label={t("edit.panel.x")}
              value={rect.x}
              onCommit={(x) => {
                update({ ...rect, x });
              }}
            />
            <NumberField
              label={t("edit.panel.y")}
              value={rect.y}
              onCommit={(y) => {
                update({ ...rect, y });
              }}
            />
            <NumberField
              label={t("edit.panel.w")}
              value={rect.w}
              onCommit={(w) => {
                update({ ...rect, w });
              }}
            />
            <NumberField
              label={t("edit.panel.h")}
              value={rect.h}
              onCommit={(h) => {
                update({ ...rect, h });
              }}
            />
            <RemoveButton
              label={label}
              onRemove={() => {
                dispatch({ type: "remove", target: { kind: "nogo", index } });
              }}
            />
          </div>
        );
      })}
    </section>
  );
}

/** Props of {@link RemoveButton}. */
interface RemoveButtonProps {
  /** Name of the item, appended to the accessible name so that each button is distinct. */
  readonly label: string;
  /** Called when the button is pressed. */
  readonly onRemove: () => void;
}

/**
 * A remove button whose accessible name names the item it removes.
 *
 * @param props - The item name and the callback.
 * @returns The button.
 */
function RemoveButton({ label, onRemove }: RemoveButtonProps): React.JSX.Element {
  const { t } = useTranslation("site");
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={`${t("edit.panel.remove")}: ${label}`}
      onClick={onRemove}
    >
      {t("edit.panel.remove")}
    </button>
  );
}
