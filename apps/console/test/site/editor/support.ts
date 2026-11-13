/**
 * Fixtures of the editor tests: a small drawing in millimetres (10 m by 5 m) with a wall and a rack.
 */
import type { DxfDocument } from "../../../src/site/dxf/types";

/** A drawing of 10 m by 5 m in millimetres: an outline wall and one closed rack, both on named layers. */
export const SMALL_DOC: DxfDocument = {
  insUnits: 4,
  layers: [
    { name: "WALLS", label: "WALLS", entityCount: 1 },
    { name: "RACKS", label: "RACKS", entityCount: 1 },
    { name: "TEXT", label: "TEXT", entityCount: 1 },
  ],
  entities: [
    { kind: "line", layer: "WALLS", a: [0, 0], b: [10000, 0] },
    {
      kind: "polyline",
      layer: "RACKS",
      points: [
        [1000, 1000],
        [3000, 1000],
        [3000, 2000],
        [1000, 2000],
      ],
      closed: true,
    },
  ],
  ignored: {},
};
