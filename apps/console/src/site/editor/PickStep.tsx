/**
 * First step of the wizard: the operator picks a DXF file, by button or by drop. The file is parsed in the worker
 * and the step hands the drawing on; a refusal stays on this step, with the reason written out.
 *
 * The button is the keyboard path; the drop zone only adds a pointer shortcut to it. Parsing is shown as a
 * polite live status, and a second file cannot start while one is being read.
 */
import type * as React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp } from "lucide-react";
import { DXF_LIMITS, DxfError, type DxfDocument, type DxfErrorCode } from "../dxf/types";
import { parseDxfFile } from "../dxf/worker-client";
import styles from "./Editor.module.css";

/** Extension the file picker offers. The parser checks it again, so the hint is not the only guard. */
const ACCEPT = ".dxf";

/** Largest file accepted, in megabytes, for the refusal message. */
const DXF_LIMIT_MB = DXF_LIMITS.maxBytes / 1_000_000;

/** Props of {@link PickStep}. */
export interface PickStepProps {
  /** Called with the parsed drawing. */
  readonly onParsed: (doc: DxfDocument) => void;
  /** Parser, injected for tests. Defaults to the worker parser. */
  readonly parse?: (file: File) => Promise<DxfDocument>;
}

/** What the step shows about the file in progress or refused. */
interface PickState {
  /** Name of the file being read, shown as text. */
  readonly fileName: string | null;
  /** Size of the file in kilobytes, rounded up. */
  readonly sizeKb: number | null;
  /** Whether the worker is reading the file. */
  readonly parsing: boolean;
  /** The refusal code of the last file, or `"generic"` for a failure without a code. */
  readonly error: DxfErrorCode | "generic" | null;
}

/** Starting state of the step: nothing picked. */
const IDLE: PickState = { fileName: null, sizeKb: null, parsing: false, error: null };

/**
 * Renders the file picking step.
 *
 * @param props - The parsed-drawing callback and the optional parser.
 * @returns The picker, its drop zone and the status of the last file.
 */
export function PickStep({ onParsed, parse = parseDxfFile }: PickStepProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<PickState>(IDLE);

  /**
   * Reads one file and reports the drawing or the refusal.
   *
   * @param file - The file chosen or dropped.
   */
  const read = async (file: File): Promise<void> => {
    if (state.parsing) {
      return;
    }
    setState({
      fileName: file.name,
      sizeKb: Math.ceil(file.size / 1024),
      parsing: true,
      error: null,
    });
    try {
      const doc = await parse(file);
      setState((current) => ({ ...current, parsing: false }));
      onParsed(doc);
    } catch (error) {
      // A refusal carries a code the UI maps to a message; anything else is shown as a generic failure.
      const code: DxfErrorCode | "generic" = error instanceof DxfError ? error.code : "generic";
      setState((current) => ({ ...current, parsing: false, error: code }));
    }
  };

  /**
   * Reads the first file of a drop.
   *
   * @param event - The drop event.
   */
  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files.item(0);
    if (file !== null) {
      void read(file);
    }
  };

  return (
    <section aria-labelledby="site-pick-title" className={styles.step}>
      <h3 id="site-pick-title" className={styles.stepTitle}>
        {t("pick.title")}
      </h3>
      <p className={styles.hint}>{t("pick.hint")}</p>
      <div
        className={styles.dropZone}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={onDrop}
      >
        <FileUp aria-hidden="true" focusable="false" className={styles.icon} />
        <button
          type="button"
          className={styles.primaryButton}
          disabled={state.parsing}
          onClick={() => {
            input.current?.click();
          }}
        >
          {t("pick.choose")}
        </button>
        <span className={styles.hint}>{t("pick.drop")}</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0);
            if (file !== null && file !== undefined) {
              void read(file);
            }
            // Cleared so that choosing the same file again still fires a change.
            event.currentTarget.value = "";
          }}
        />
      </div>
      <div role="status" aria-live="polite" className={styles.status}>
        {state.parsing ? <p>{t("pick.parsing")}</p> : null}
        {state.fileName !== null && !state.parsing && state.error === null ? (
          <p>
            {t("pick.parsed")}: {state.fileName}
            {state.sizeKb === null ? null : ` (${t("pick.size", { kb: state.sizeKb })})`}
          </p>
        ) : null}
      </div>
      {state.error === null ? null : (
        <p role="alert" className={styles.error}>
          {state.error === "generic"
            ? t("errors.generic")
            : t(`errors.dxf.${state.error}`, { limitMb: DXF_LIMIT_MB })}
        </p>
      )}
    </section>
  );
}
