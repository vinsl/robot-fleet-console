/**
 * Third step of the wizard: the plan with the charger, the workstations and the no-go zones placed on it.
 *
 * The canvas is for pointers; the feature panel gives the same actions and the exact positions to a keyboard.
 * The draft is checked as it changes: the issues list says what is missing, and when the draft is complete the
 * protocol check is run on it, so the operator sees the same verdict the server will give.
 */
import type * as React from "react";
import type { Dispatch } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EditorFeatures, Imported } from "../dxf/build-site-map";
import { mapViewBox, markerUnit } from "../render/map-geometry";
import { SiteMapView } from "../render/SiteMapView";
import { MapLegend } from "../render/MapLegend";
import { buildDraftMap, draftIssues, draftLayers, type DraftIssue, type FeatureRef } from "./draft";
import { EditorOverlay } from "./EditorOverlay";
import { FeaturePanel } from "./FeaturePanel";
import { SaveAlert } from "./SaveAlert";
import type { SaveStatus, Tool, WizardAction } from "./wizard-reducer";
import styles from "./Editor.module.css";

/** Tools of the toolbar, in order, with the key that selects each. */
const TOOLS: readonly { readonly tool: Tool; readonly key: string }[] = [
  { tool: "select", key: "V" },
  { tool: "charger", key: "C" },
  { tool: "workstation", key: "W" },
  { tool: "nogo", key: "N" },
];

/** Props of {@link EditorStep}. */
export interface EditorStepProps {
  /** The imported geometry of the plan. */
  readonly imported: Imported;
  /** The features placed so far. */
  readonly editor: EditorFeatures;
  /** The current tool. */
  readonly tool: Tool;
  /** The selected feature, if any. */
  readonly selection: FeatureRef | null;
  /** Sends the changes to the wizard. */
  readonly dispatch: Dispatch<WizardAction>;
  /** Progress of the save; a failed save is explained next to the actions. */
  readonly save: SaveStatus;
  /** Saves the draft as a new version. */
  readonly onSave: () => void;
  /** Validates the uploaded version again after a validation failure. */
  readonly onRetryValidation: () => void;
  /** Called to go back to the layer mapping. */
  readonly onBack: () => void;
}

/**
 * Renders the editor step.
 *
 * @param props - The plan, the draft, the tool, the selection, the save and the dispatcher.
 * @returns The editor.
 */
export function EditorStep({
  imported,
  editor,
  tool,
  selection,
  dispatch,
  save,
  onSave,
  onRetryValidation,
  onBack,
}: EditorStepProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const layers = useMemo(() => draftLayers(imported, editor), [imported, editor]);
  const view = useMemo(() => mapViewBox(layers), [layers]);
  const unit = useMemo(() => markerUnit(layers), [layers]);
  const issues = useMemo(() => draftIssues(editor, imported.extent), [editor, imported.extent]);
  // The protocol check runs only on a complete draft; an incomplete one would only repeat the issues above.
  const protocolReady = useMemo(
    () => (issues.length === 0 ? buildDraftMap(imported, editor) !== null : false),
    [imported, editor, issues.length],
  );
  const saving = save.kind === "saving";

  /**
   * Handles the tool shortcuts. Keys typed into a field are left to the field.
   *
   * @param event - The key event of the editor.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isField(event.target)) {
      return;
    }
    const key = event.key.toUpperCase();
    const shortcut = TOOLS.find((entry) => entry.key === key);
    if (shortcut !== undefined) {
      dispatch({ type: "setTool", tool: shortcut.tool });
    }
  };

  return (
    <section aria-labelledby="site-edit-title" className={styles.step} onKeyDown={onKeyDown}>
      <h3 id="site-edit-title" className={styles.stepTitle}>
        {t("edit.title")}
      </h3>
      <p className={styles.hint}>{t("edit.hint")}</p>

      <div role="toolbar" aria-label={t("edit.toolsLabel")} className={styles.toolbar}>
        {TOOLS.map((entry) => (
          <button
            key={entry.tool}
            type="button"
            aria-pressed={tool === entry.tool}
            aria-keyshortcuts={entry.key}
            className={styles.toolButton}
            onClick={() => {
              dispatch({ type: "setTool", tool: entry.tool });
            }}
          >
            {t(`edit.tools.${entry.tool}`)}
          </button>
        ))}
      </div>

      <div className={styles.editorGrid}>
        <figure className={styles.canvas}>
          <SiteMapView layers={layers} label={t("edit.mapLabel")}>
            <EditorOverlay
              editor={editor}
              view={view}
              unit={unit}
              tool={tool}
              selection={selection}
              dispatch={dispatch}
            />
          </SiteMapView>
          <figcaption className={styles.legendRow}>
            <MapLegend />
          </figcaption>
        </figure>

        <div className={styles.side}>
          <FeaturePanel
            imported={imported}
            editor={editor}
            selection={selection}
            dispatch={dispatch}
          />
          <IssuesList issues={issues} protocolReady={protocolReady} editor={editor} />
        </div>
      </div>

      {save.kind === "failed" ? (
        <SaveAlert failure={save.failure} busy={saving} onRetryValidation={onRetryValidation} />
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onBack}>
          {t("edit.back")}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!protocolReady || saving}
          aria-busy={saving}
          onClick={onSave}
        >
          {saving ? t("edit.saving") : t("edit.save")}
        </button>
      </div>
    </section>
  );
}

/**
 * Tells whether the event target is a field the operator types into, so that shortcuts do not fire there.
 *
 * @param target - The event target.
 * @returns `true` for an input, a select or a text area.
 */
function isField(target: EventTarget): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

/** Props of {@link IssuesList}. */
interface IssuesListProps {
  /** The reasons the draft is not complete. */
  readonly issues: readonly DraftIssue[];
  /** Whether a complete draft also passed the protocol check. */
  readonly protocolReady: boolean;
  /** The features, for the names and numbers in the messages. */
  readonly editor: EditorFeatures;
}

/**
 * Lists what the draft still needs, as a live status. A complete draft says so, or says the protocol refused it.
 *
 * @param props - The issues, the protocol verdict and the features.
 * @returns The status region.
 */
function IssuesList({ issues, protocolReady, editor }: IssuesListProps): React.JSX.Element {
  const { t } = useTranslation("site");

  /**
   * The sentence for one issue.
   *
   * @param issue - The issue.
   * @returns The translated text.
   */
  const messageOf = (issue: DraftIssue): string => {
    switch (issue.kind) {
      case "noCharger":
        return t("edit.issues.noCharger");
      case "fewWorkstations":
        return t("edit.issues.fewStations");
      case "badName":
        return t("edit.issues.badName", { number: issue.index + 1 });
      case "duplicateName":
        return t("edit.issues.duplicateName", {
          name: editor.workstations[issue.index]?.name ?? "",
        });
      case "badNogo":
        return t("edit.issues.badNogo", { number: issue.index + 1 });
      case "badSize":
        return t("edit.issues.badSize", {
          name: editor.workstations[issue.index]?.name ?? "",
        });
      case "outside":
        return outsideMessage(issue.item);
    }
  };

  /**
   * The sentence for a feature outside the plan.
   *
   * @param item - The feature.
   * @returns The translated text.
   */
  const outsideMessage = (item: FeatureRef): string => {
    switch (item.kind) {
      case "charger":
        return t("edit.issues.outside.charger");
      case "workstation":
        return t("edit.issues.outside.workstation", {
          name: editor.workstations[item.index]?.name ?? "",
        });
      case "nogo":
        return t("edit.issues.outside.nogo", { number: item.index + 1 });
    }
  };

  const complete = issues.length === 0;
  return (
    <div role="status" aria-live="polite" className={styles.issues}>
      <h4 className={styles.panelTitle}>{t("edit.issues.title")}</h4>
      {complete ? (
        <p>{protocolReady ? t("edit.issues.complete") : t("edit.issues.protocolRefusal")}</p>
      ) : (
        <ul className={styles.list}>
          {issues.map((issue, index) => (
            <li key={`${issue.kind}-${String(index)}`}>{messageOf(issue)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
