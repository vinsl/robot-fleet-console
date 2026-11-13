/**
 * Builders of the site fixtures: a valid site map for a given version, and stored version records in each
 * state. Every builder returns a fresh value, so a test can change it without affecting another.
 */
import type { MapStatus, SiteMap } from "@mfc/protocol";
import type { MapRecord } from "../../src/domain/site/ports";
import { TEST_ACTOR } from "./fakes";

/**
 * A valid site map: two walls, one obstacle, one charger and two named workstations, within the bounds.
 *
 * @param version - The version the file declares in its `fleet` member.
 * @returns A map that passes `SiteMapSchema`.
 */
export function validSiteMap(version: number): SiteMap {
  return {
    type: "FeatureCollection",
    fleet: { crs: "local-metric", version },
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [20, 0],
          ],
        },
        properties: { kind: "wall" },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [20, 0],
            [20, 10],
          ],
        },
        properties: { kind: "wall" },
      },
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [2, 2],
              [4, 2],
              [4, 3],
              [2, 3],
              [2, 2],
            ],
          ],
        },
        properties: { kind: "obstacle" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [1, 1] },
        properties: { kind: "charger" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [10, 5] },
        properties: { kind: "workstation", name: "ws-1" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [15, 5] },
        properties: { kind: "workstation", name: "ws-2" },
      },
    ],
  };
}

/** Storage key of the fixture version of a site. */
export const FIXTURE_KEY_PREFIX = "sites/paris-01/maps/";

/**
 * A stored version record in the given state. A `VALID` one carries the pinned object facts; a `PENDING` one carries
 * none.
 *
 * @param version - The version number.
 * @param status - The state of the version.
 * @returns The record.
 */
export function mapRecordOf(version: number, status: MapStatus): MapRecord {
  const key = `${FIXTURE_KEY_PREFIX}${String(version).padStart(6, "0")}.geojson`;
  const base: MapRecord = {
    version,
    status: "PENDING",
    createdAt: "2026-11-02T09:00:00.000Z",
    createdBy: TEST_ACTOR,
    s3Key: key,
    s3VersionId: null,
    sha256: null,
    sizeBytes: null,
    summary: null,
  };
  if (status === "PENDING") {
    return base;
  }
  return {
    ...base,
    status: "VALID",
    s3VersionId: `pinned-${String(version)}`,
    sha256: "a".repeat(64),
    sizeBytes: 1234,
    summary: {
      counts: { wall: 2, obstacle: 1, charger: 1, workstation: 2, nogo: 0 },
      extentM: { x: 20, y: 10 },
    },
  };
}
