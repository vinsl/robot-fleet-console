/**
 * Hook that runs the saves of the editor against the API and the presigned upload.
 *
 * The hook is single-flight: while one save or one validation retry is running, a second call returns `null`
 * without a request. A ref is used rather than the pending state, because two clicks in the same frame both see
 * the state before it changes; the ref does not.
 */
import { useRef } from "react";
import type { MapVersion, MapVersionNumber } from "@mfc/protocol";
import { useCreateMap, useValidateMap } from "../../api/site";
import { uploadToPresignedPost } from "../upload";
import type { EditorFeatures, Imported } from "../dxf/build-site-map";
import { saveMapVersion, validateSavedMap, type SaveDeps } from "./save-map";

/** What the editor can ask of the save. */
interface SaveController {
  /**
   * Saves the plan as a new version. Resolves with `null` when another save was already running.
   *
   * @param imported - The imported geometry of the plan.
   * @param editor - The features placed on the plan.
   * @returns The validated version, or `null` when this call was ignored.
   */
  readonly save: (imported: Imported, editor: EditorFeatures) => Promise<MapVersion | null>;
  /**
   * Validates a version whose upload succeeded but whose validation failed. Resolves with `null` when another
   * save was already running.
   *
   * @param version - The uploaded version.
   * @returns The validated version, or `null` when this call was ignored.
   */
  readonly retryValidation: (version: MapVersionNumber) => Promise<MapVersion | null>;
}

/**
 * Provides the save and the validation retry of the editor.
 *
 * @returns The save controller.
 */
export function useSaveMap(): SaveController {
  const createMap = useCreateMap();
  const validateMap = useValidateMap();
  const inFlight = useRef(false);

  const deps: SaveDeps = {
    createMap: () => createMap.mutateAsync(),
    upload: (upload, body) => uploadToPresignedPost(upload, body),
    validate: (version) => validateMap.mutateAsync(version),
  };

  /**
   * Runs one task unless another is running.
   *
   * @param task - The task to run.
   * @returns The task's result, or `null` when it was ignored.
   */
  const singleFlight = async <T>(task: () => Promise<T>): Promise<T | null> => {
    if (inFlight.current) {
      return null;
    }
    inFlight.current = true;
    try {
      return await task();
    } finally {
      inFlight.current = false;
    }
  };

  return {
    save: (imported, editor) => singleFlight(() => saveMapVersion(deps, imported, editor)),
    retryValidation: (version) => singleFlight(() => validateSavedMap(deps.validate, version)),
  };
}
