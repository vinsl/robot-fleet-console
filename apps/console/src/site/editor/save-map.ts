/**
 * Saves the drawn plan as a new map version: reserves the version, uploads the map, then validates it.
 *
 * The three steps are separate requests, and each can fail on its own, so a failure says where it happened. A
 * version reserved and uploaded but not validated stays `PENDING` on the server, where the operator can validate
 * it again; nothing here retries on its own, because a presigned POST is single use and expires.
 *
 * The dependencies are passed in, so the order of the calls and every failure are tested without a network.
 */
import {
  SITE_MAP_CONTENT_TYPE,
  SITE_MAP_MAX_BYTES,
  type CreateMapResponse,
  type MapVersion,
  type MapVersionNumber,
} from "@mfc/protocol";
import {
  buildSiteMap,
  SiteMapBuildError,
  type EditorFeatures,
  type Imported,
} from "../dxf/build-site-map";
import { SiteUploadError, type SiteUploadErrorKind } from "../upload";

/**
 * Largest version number the protocol accepts. Its digits bound the body of any version, so the size of a plan is
 * checked on this number before a slot is reserved.
 */
const LARGEST_VERSION = 999_999;

/** Step of the save that failed. */
type SaveStage = "build" | "slot" | "upload" | "validate";

/**
 * Why the save failed. `build` is a plan the protocol refuses or a map too large to send; `api` is a refused
 * request to the API; `unexpected` is any other failure, shown without detail; the rest are the upload categories.
 */
type SaveReason = "build" | "api" | "unexpected" | SiteUploadErrorKind;

/**
 * The failure of a save, as the UI needs it. `version` is the version reserved before the failure, or `null` when
 * none was reserved; a reserved version that was uploaded can be validated again.
 */
export interface SaveFailure {
  /** Step that failed. */
  readonly stage: SaveStage;
  /** Category of the failure. */
  readonly reason: SaveReason;
  /** Version reserved before the failure, if any. */
  readonly version: MapVersionNumber | null;
}

/** A failed save. Carries the failure as plain data, so the UI can keep it in its state. */
export class SaveMapError extends Error {
  /** The failure. */
  readonly failure: SaveFailure;

  /**
   * @param failure - The failure.
   */
  constructor(failure: SaveFailure) {
    super(`map save failed at ${failure.stage}: ${failure.reason}`);
    this.name = "SaveMapError";
    this.failure = failure;
  }
}

/** The calls a save makes, injected so the order and the failures are testable. */
export interface SaveDeps {
  /** Reserves a version and returns its presigned POST. */
  readonly createMap: () => Promise<CreateMapResponse>;
  /** Uploads the map body to the presigned POST. */
  readonly upload: (upload: CreateMapResponse["upload"], body: Blob) => Promise<void>;
  /** Validates an uploaded version and returns it. */
  readonly validate: (version: MapVersionNumber) => Promise<MapVersion>;
}

/**
 * Builds the GeoJSON body of a plan for one version number. The protocol check runs here.
 *
 * @param imported - The imported geometry of the plan.
 * @param editor - The features placed on the plan.
 * @param version - The version number written in the body.
 * @returns The body, with its media type.
 * @throws {SiteMapBuildError} When the protocol refuses the plan.
 */
function encodeSiteMap(imported: Imported, editor: EditorFeatures, version: number): Blob {
  const map = buildSiteMap(imported, editor, version);
  return new Blob([JSON.stringify(map)], { type: SITE_MAP_CONTENT_TYPE });
}

/**
 * Throws the save failure for a stage.
 *
 * @param stage - The step that failed.
 * @param reason - Why it failed.
 * @param version - The version reserved so far, if any.
 * @throws {SaveMapError} Always.
 */
function fail(stage: SaveStage, reason: SaveReason, version: MapVersionNumber | null): never {
  throw new SaveMapError({ stage, reason, version });
}

/**
 * Validates a version that was uploaded earlier. Used by the save itself and by the retry the UI offers after a
 * validation failure.
 *
 * @param validate - The validation call.
 * @param version - The version to validate.
 * @returns The validated version.
 * @throws {SaveMapError} At the `validate` stage when the API refuses the validation.
 */
export async function validateSavedMap(
  validate: SaveDeps["validate"],
  version: MapVersionNumber,
): Promise<MapVersion> {
  try {
    return await validate(version);
  } catch {
    return fail("validate", "api", version);
  }
}

/**
 * Saves a drawn plan as a new map version.
 *
 * The plan is checked against the protocol and sized before any version number is reserved, so a refused or
 * oversized plan costs no slot. The version number comes from the server, so the body is built again, with that
 * number, once the slot is reserved.
 *
 * @param deps - The save calls.
 * @param imported - The imported geometry of the plan.
 * @param editor - The features placed on the plan.
 * @returns The validated version.
 * @throws {SaveMapError} At the stage that failed.
 */
export async function saveMapVersion(
  deps: SaveDeps,
  imported: Imported,
  editor: EditorFeatures,
): Promise<MapVersion> {
  // The version is the only field of the body that depends on the slot, and it never has more digits than
  // LARGEST_VERSION, so this size bounds the body of every version the server can reserve.
  let sizing: Blob;
  try {
    sizing = encodeSiteMap(imported, editor, LARGEST_VERSION);
  } catch (error) {
    if (error instanceof SiteMapBuildError) {
      return fail("build", "build", null);
    }
    throw error;
  }
  if (sizing.size > SITE_MAP_MAX_BYTES) {
    return fail("build", "build", null);
  }

  let slot: CreateMapResponse;
  try {
    slot = await deps.createMap();
  } catch {
    return fail("slot", "api", null);
  }
  const { version, upload } = slot;

  let body: Blob;
  try {
    body = encodeSiteMap(imported, editor, version);
  } catch {
    // The slot is reserved: keep its number, so the operator sees which version was not sent.
    return fail("build", "unexpected", version);
  }

  try {
    await deps.upload(upload, body);
  } catch (error) {
    return fail("upload", error instanceof SiteUploadError ? error.kind : "unexpected", version);
  }

  return validateSavedMap(deps.validate, version);
}
