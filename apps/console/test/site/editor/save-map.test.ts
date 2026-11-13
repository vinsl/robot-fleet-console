/**
 * Save of a drawn plan: the order of the three calls, the stage of each failure, and the refusal before any slot
 * is reserved. The calls are fakes, so no request leaves the test.
 */
import { describe, expect, it, vi } from "vitest";
import type { MapVersion } from "@mfc/protocol";
import { buildSiteMap } from "../../../src/site/dxf/build-site-map";
import type { Point } from "../../../src/site/dxf/types";
import { SiteUploadError } from "../../../src/site/upload";
import {
  saveMapVersion,
  SaveMapError,
  validateSavedMap,
  type SaveDeps,
} from "../../../src/site/editor/save-map";
import { completeDraft, slotFor } from "./draft-fixture";

// The body builder is wrapped in a spy, so a test can make it fail after the slot is reserved.
vi.mock("../../../src/site/dxf/build-site-map", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/site/dxf/build-site-map")>();
  return { ...original, buildSiteMap: vi.fn(original.buildSiteMap) };
});

/**
 * A validated version as the API returns it, for the fakes.
 *
 * @param version - Version number.
 * @returns The version.
 */
function validated(version: number): MapVersion {
  return {
    version,
    status: "VALID",
    createdAt: "2026-11-03T10:00:00.000Z",
    createdBy: "admin-1",
    sizeBytes: 1024,
    summary: null,
    active: false,
  };
}

/**
 * Fakes of the three calls, each succeeding unless a test replaces it.
 *
 * @returns The dependencies and their spies.
 */
function fakes(): SaveDeps & {
  createMap: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
} {
  return {
    createMap: vi.fn(() => Promise.resolve(slotFor(2))),
    upload: vi.fn(() => Promise.resolve()),
    validate: vi.fn((version: number) => Promise.resolve(validated(version))),
  };
}

/**
 * Captures the failure of a rejected save.
 *
 * @param promise - The save.
 * @returns The thrown failure.
 */
async function failureOf(promise: Promise<unknown>): Promise<SaveMapError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SaveMapError) {
      return error;
    }
    throw error;
  }
  throw new Error("the save was expected to fail");
}

describe("saveMapVersion", () => {
  it("reserves a slot, uploads the map, then validates the reserved version", async () => {
    const deps = fakes();
    const { imported, editor } = completeDraft();
    const version = await saveMapVersion(deps, imported, editor);

    expect(version.version).toBe(2);
    const order = [deps.createMap, deps.upload, deps.validate].map(
      (spy) => spy.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(deps.createMap).toHaveBeenCalledTimes(1);
    expect(deps.validate).toHaveBeenCalledWith(2);
  });

  it("uploads a GeoJSON body with its media type and the version the server reserved", async () => {
    const deps = fakes();
    const { imported, editor } = completeDraft();
    await saveMapVersion(deps, imported, editor);

    const [upload, body] = deps.upload.mock.calls[0] as [unknown, Blob];
    expect(upload).toEqual(slotFor(2).upload);
    expect(body.type).toBe("application/geo+json");
    const parsed = JSON.parse(await body.text()) as { fleet: { version: number } };
    expect(parsed.fleet.version).toBe(2);
  });

  it("refuses a plan the protocol does not accept before any slot is reserved", async () => {
    const deps = fakes();
    const { imported } = completeDraft();
    const failure = await failureOf(
      saveMapVersion(deps, imported, { charger: null, workstations: [], nogo: [] }),
    );

    expect(failure.failure).toEqual({ stage: "build", reason: "build", version: null });
    expect(deps.createMap).not.toHaveBeenCalled();
  });

  it("reports a refused reservation at the slot stage, with no upload", async () => {
    const deps = fakes();
    deps.createMap.mockRejectedValueOnce(new Error("refused"));
    const { imported, editor } = completeDraft();
    const failure = await failureOf(saveMapVersion(deps, imported, editor));

    expect(failure.failure).toEqual({ stage: "slot", reason: "api", version: null });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("refuses an oversized plan before any slot is reserved", async () => {
    const deps = fakes();
    const { imported, editor } = completeDraft();
    // Negative full-precision decimals push the body past the 2 MB bound, while the positions stay within the
    // protocol's count (50 000) and extent (1 000 m) limits, so only the size check refuses the plan. The
    // obstacles are dropped to keep the count below the limit.
    const wall: Point[] = Array.from({ length: 49_990 }, (_, index) => [
      -100 - ((index % 900) + 1 / 3),
      -((Math.floor(index / 900) % 900) + 2 / 3),
    ]);
    const failure = await failureOf(
      saveMapVersion(deps, { ...imported, walls: [wall], obstacles: [] }, editor),
    );

    expect(failure.failure).toEqual({ stage: "build", reason: "build", version: null });
    expect(deps.createMap).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("keeps the reserved version when building the body fails with an unexpected error", async () => {
    const actual = await vi.importActual<typeof import("../../../src/site/dxf/build-site-map")>(
      "../../../src/site/dxf/build-site-map",
    );
    vi.mocked(buildSiteMap).mockImplementation((imported, editor, version) => {
      if (version === 2) {
        throw new TypeError("unexpected");
      }
      return actual.buildSiteMap(imported, editor, version);
    });
    try {
      const deps = fakes();
      const { imported, editor } = completeDraft();
      const failure = await failureOf(saveMapVersion(deps, imported, editor));

      expect(failure.failure).toEqual({ stage: "build", reason: "unexpected", version: 2 });
      expect(deps.upload).not.toHaveBeenCalled();
    } finally {
      vi.mocked(buildSiteMap).mockImplementation(actual.buildSiteMap);
    }
  });

  it("keeps the reserved version and skips validation when the upload is too large", async () => {
    const deps = fakes();
    deps.upload.mockRejectedValueOnce(new SiteUploadError("too-large"));
    const { imported, editor } = completeDraft();
    const failure = await failureOf(saveMapVersion(deps, imported, editor));

    expect(failure.failure).toEqual({ stage: "upload", reason: "too-large", version: 2 });
    expect(deps.validate).not.toHaveBeenCalled();
  });

  it("keeps the uploaded version when validation fails, so it can be validated again", async () => {
    const deps = fakes();
    deps.validate.mockRejectedValueOnce(new Error("refused"));
    const { imported, editor } = completeDraft();
    const failure = await failureOf(saveMapVersion(deps, imported, editor));

    expect(failure.failure).toEqual({ stage: "validate", reason: "api", version: 2 });
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });
});

describe("validateSavedMap", () => {
  it("validates a version again and returns it", async () => {
    const validate = vi.fn((version: number) => Promise.resolve(validated(version)));
    await expect(validateSavedMap(validate, 3)).resolves.toMatchObject({
      version: 3,
      status: "VALID",
    });
    expect(validate).toHaveBeenCalledWith(3);
  });

  it("reports a refused validation at the validate stage with the version", async () => {
    const validate = vi.fn(() => Promise.reject(new Error("refused")));
    const failure = await failureOf(validateSavedMap(validate, 3));
    expect(failure.failure).toEqual({ stage: "validate", reason: "api", version: 3 });
  });
});
