/**
 * The editor section of the site sheet: shows the wizard step that its state is in, and runs the save.
 *
 * The state is owned by the page, above the sections, so a change of tab and the discard check on close both see
 * the work. This component holds no state of its own besides the save controller, which is single-flight.
 */
import type * as React from "react";
import type { Dispatch } from "react";
import { EditorStep } from "./EditorStep";
import { MappingStep } from "./MappingStep";
import { PickStep } from "./PickStep";
import { SavedPanel } from "./SavedPanel";
import { failureOf } from "./save-failure";
import { useSaveMap } from "./use-save-map";
import type { WizardAction, WizardState } from "./wizard-reducer";

/** Props of {@link SiteEditor}. */
export interface SiteEditorProps {
  /** The wizard state, owned by the page. */
  readonly state: WizardState;
  /** Sends the changes to the wizard. */
  readonly dispatch: Dispatch<WizardAction>;
  /** Shows the versions list. */
  readonly onViewVersions: () => void;
}

/**
 * Renders the wizard's current step, or the saved version once the save is done.
 *
 * @param props - The state, its dispatcher and the navigation to the versions list.
 * @returns The step on screen.
 */
export function SiteEditor({
  state,
  dispatch,
  onViewVersions,
}: SiteEditorProps): React.JSX.Element {
  const saver = useSaveMap();
  const { step, doc, imported, save } = state;

  /**
   * Saves the draft. A save that another call already runs is ignored by the controller, and the state keeps
   * showing that run.
   */
  const onSave = (): void => {
    if (imported === null) {
      return;
    }
    dispatch({ type: "saveStarted" });
    saver.save(imported, state.editor).then(
      (version) => {
        if (version !== null) {
          dispatch({ type: "saved", version });
        }
      },
      (error: unknown) => {
        dispatch({ type: "saveFailed", failure: failureOf(error) });
      },
    );
  };

  /**
   * Validates again the version of a failed save, when its upload succeeded. Nothing happens otherwise.
   */
  const onRetryValidation = (): void => {
    if (save.kind !== "failed" || save.failure.version === null) {
      return;
    }
    dispatch({ type: "saveStarted" });
    saver.retryValidation(save.failure.version).then(
      (validated) => {
        if (validated !== null) {
          dispatch({ type: "saved", version: validated });
        }
      },
      (error: unknown) => {
        dispatch({ type: "saveFailed", failure: failureOf(error) });
      },
    );
  };

  if (save.kind === "done") {
    return (
      <SavedPanel
        version={save.version}
        onViewVersions={onViewVersions}
        onEditAnother={() => {
          dispatch({ type: "reset" });
        }}
      />
    );
  }

  // The step and the data it needs are set together by the reducer; a step whose data is missing falls back to
  // the picker, which is also where the wizard starts.
  if (step === "edit" && imported !== null) {
    return (
      <EditorStep
        imported={imported}
        editor={state.editor}
        tool={state.tool}
        selection={state.selection}
        dispatch={dispatch}
        save={save}
        onSave={onSave}
        onRetryValidation={onRetryValidation}
        onBack={() => {
          dispatch({ type: "back" });
        }}
      />
    );
  }
  if (step === "mapping" && doc !== null) {
    return (
      <MappingStep
        doc={doc}
        mapping={state.mapping}
        metresPerUnit={state.metresPerUnit}
        error={state.error}
        onRole={(layer, role) => {
          dispatch({ type: "setRole", layer, role });
        }}
        onScale={(scale) => {
          dispatch({ type: "setScale", scale });
        }}
        onContinue={() => {
          dispatch({ type: "confirmMapping" });
        }}
        onBack={() => {
          dispatch({ type: "back" });
        }}
      />
    );
  }
  return (
    <PickStep
      onParsed={(parsed) => {
        dispatch({ type: "parsed", doc: parsed });
      }}
    />
  );
}
