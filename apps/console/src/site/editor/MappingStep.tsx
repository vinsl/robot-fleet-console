/**
 * Second step of the wizard: each drawing layer gets a role (wall, obstacle or ignored), and the drawing gets its
 * scale. A live preview shows what the import will keep, so a wrong role or scale is seen before the editor.
 *
 * Layer names are shown as text, never as markup. The table is long for a big drawing, so it scrolls in its own
 * region, which is focusable and labelled for keyboard users.
 */
import type * as React from "react";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MAX_EXTENT_M } from "@mfc/protocol";
import { importGeometry } from "../dxf/build-site-map";
import {
  layerRoles,
  suggestMapping,
  type LayerMapping,
  type LayerRole,
} from "../dxf/layer-mapping";
import { metresPerUnit as metresPerUnitOf } from "../dxf/units";
import type { DxfDocument } from "../dxf/types";
import { SiteMapView } from "../render/SiteMapView";
import { draftLayers, EMPTY_FEATURES } from "./draft";
import { isUsableScale, type WizardError } from "./wizard-reducer";
import styles from "./Editor.module.css";

/** Roles a layer can take, in the order of the select. */
const ROLES: readonly LayerRole[] = ["wall", "obstacle", "ignore"];

/**
 * Reads the role of a select option, refusing any value that is not a role.
 *
 * @param value - The option value.
 * @returns The role, or `undefined` for an unknown value.
 */
function roleOf(value: string): LayerRole | undefined {
  return ROLES.find((role) => role === value);
}

/** Props of {@link MappingStep}. */
export interface MappingStepProps {
  /** The parsed drawing. */
  readonly doc: DxfDocument;
  /** The role of each layer. */
  readonly mapping: LayerMapping;
  /** Metres per drawing unit, or `null` when none is set yet. */
  readonly metresPerUnit: number | null;
  /** A failure to show next to the scale, if any. */
  readonly error: WizardError | null;
  /** Called when the operator changes the role of a layer. */
  readonly onRole: (layer: string, role: LayerRole) => void;
  /** Called with the typed scale; `null` when the field is empty or not a number. */
  readonly onScale: (scale: number | null) => void;
  /** Called to confirm the mapping and go to the editor. */
  readonly onContinue: () => void;
  /** Called to go back to the file picker. */
  readonly onBack: () => void;
}

/**
 * Renders the layer mapping step with its preview.
 *
 * @param props - The drawing, the mapping, the scale and the callbacks.
 * @returns The step.
 */
export function MappingStep({
  doc,
  mapping,
  metresPerUnit,
  error,
  onRole,
  onScale,
  onContinue,
  onBack,
}: MappingStepProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const scaleId = useId();
  const scaleUsable = isUsableScale(metresPerUnit);
  const roles = useMemo(() => layerRoles(mapping), [mapping]);
  const suggested = useMemo(() => layerRoles(suggestMapping(doc.layers)), [doc.layers]);

  // The preview runs the same import as the confirmation, so what is drawn here is what the editor receives.
  const imported = useMemo(
    () => (isUsableScale(metresPerUnit) ? importGeometry({ doc, mapping, metresPerUnit }) : null),
    [doc, mapping, metresPerUnit],
  );
  const preview = useMemo(() => draftLayers(imported, EMPTY_FEATURES), [imported]);

  // The header unit is only named when the console knows it; any other code leaves the scale to the operator.
  const unitKey =
    doc.insUnits === null || metresPerUnitOf(doc.insUnits) === null ? null : String(doc.insUnits);

  return (
    <section aria-labelledby="site-mapping-title" className={styles.step}>
      <h3 id="site-mapping-title" className={styles.stepTitle}>
        {t("mapping.title")}
      </h3>

      <div
        role="region"
        aria-label={t("mapping.layersLabel")}
        tabIndex={0}
        className={styles.scroll}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t("mapping.layer")}</th>
              <th scope="col">{t("mapping.entities")}</th>
              <th scope="col">{t("mapping.role")}</th>
            </tr>
          </thead>
          <tbody>
            {doc.layers.map((layer) => {
              const role = roles.get(layer.name) ?? "ignore";
              const isSuggested = suggested.get(layer.name) === role;
              return (
                <tr key={layer.name}>
                  <th scope="row" className={styles.layerName}>
                    {layer.label}
                  </th>
                  <td>{layer.entityCount}</td>
                  <td>
                    <select
                      aria-label={`${t("mapping.role")}: ${layer.label}`}
                      value={role}
                      className={styles.select}
                      onChange={(event) => {
                        const next = roleOf(event.currentTarget.value);
                        if (next !== undefined) {
                          onRole(layer.name, next);
                        }
                      }}
                    >
                      {ROLES.map((option) => (
                        <option key={option} value={option}>
                          {t(`mapping.roles.${option}`)}
                        </option>
                      ))}
                    </select>
                    {isSuggested ? (
                      <span className={styles.suggested}> ({t("mapping.suggested")})</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.scaleRow}>
        <label htmlFor={scaleId}>{t("mapping.scale")}</label>
        <input
          id={scaleId}
          type="number"
          step="any"
          inputMode="decimal"
          className={styles.input}
          value={metresPerUnit ?? ""}
          aria-invalid={!scaleUsable}
          aria-describedby={`${scaleId}-hint`}
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            onScale(event.currentTarget.value === "" || !Number.isFinite(value) ? null : value);
          }}
        />
        <p id={`${scaleId}-hint`} className={styles.hint}>
          {unitKey === null
            ? t("mapping.scaleMissing")
            : t("mapping.scaleHint", { unit: t(`mapping.units.${unitKey}`) })}
        </p>
      </div>
      {error === null ? null : (
        <p role="alert" className={styles.error}>
          {t(`errors.${error}`, { limitM: MAX_EXTENT_M })}
        </p>
      )}

      <p className={styles.hint}>
        {t("mapping.summary", {
          walls: imported?.walls.length ?? 0,
          obstacles: imported?.obstacles.length ?? 0,
          skipped: imported?.skippedOpenObstacles ?? 0,
        })}
      </p>

      <figure className={styles.preview}>
        <SiteMapView layers={preview} label={t("mapping.preview")} />
      </figure>

      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onBack}>
          {t("mapping.back")}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!scaleUsable}
          onClick={onContinue}
        >
          {t("mapping.continue")}
        </button>
      </div>
    </section>
  );
}
