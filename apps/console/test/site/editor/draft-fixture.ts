/**
 * A complete draft of the editor fixture drawing: imported, with a charger and two workstations placed.
 * Shared by the save and the editor tests, so both start from the same plan.
 */
import { SITE_MAP_MAX_BYTES, type CreateMapResponse } from "@mfc/protocol";
import type { EditorFeatures, Imported } from "../../../src/site/dxf/build-site-map";
import {
  wizardReducer,
  INITIAL_WIZARD_STATE,
  type WizardState,
} from "../../../src/site/editor/wizard-reducer";
import { SMALL_DOC } from "./support";

/**
 * The wizard state of a complete draft: the fixture drawing confirmed, one charger and two workstations placed.
 *
 * @returns The state, with `imported` set.
 */
export function completeDraftState(): WizardState {
  let state = wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC });
  state = wizardReducer(state, { type: "confirmMapping" });
  state = wizardReducer(state, { type: "placeCharger", at: [1, 1] });
  // The drawing is 2 m high: a 2 m footprint centred at y = 1 stays on the plan.
  state = wizardReducer(state, { type: "addWorkstation", at: [2, 1] });
  state = wizardReducer(state, { type: "addWorkstation", at: [4, 1] });
  return state;
}

/**
 * The imported geometry and the features of {@link completeDraftState}, for the save functions.
 *
 * @returns The plan and the features.
 */
export function completeDraft(): { imported: Imported; editor: EditorFeatures } {
  const state = completeDraftState();
  if (state.imported === null) {
    throw new Error("the fixture drawing must import");
  }
  return { imported: state.imported, editor: state.editor };
}

/**
 * A presigned POST slot for the save tests.
 *
 * @param version - Version the server reserved.
 * @returns The slot.
 */
export function slotFor(version: number): CreateMapResponse {
  return {
    version,
    upload: {
      url: "https://fleet-maps.s3.eu-west-3.amazonaws.com/",
      fields: {
        key: `sites/demo/maps/${String(version)}.geojson`,
        "Content-Type": "application/geo+json",
      },
      expiresAt: "2026-11-03T10:05:00.000Z",
    },
    maxBytes: SITE_MAP_MAX_BYTES,
  };
}
