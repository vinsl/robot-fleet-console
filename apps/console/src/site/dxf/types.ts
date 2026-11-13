/**
 * Types of the DXF core: the flattened drawing the console needs, the limits of the import and the errors it
 * can raise.
 *
 * The core is pure data and logic with no DOM, so it runs in Node tests and in the parsing worker alike. A
 * DXF file is untrusted input from the internet, so every limit is a constant here and every refusal is a
 * {@link DxfError} with a fixed code: the message never echoes the file.
 */

/** A point `[x, y]` in drawing units (or metres, once {@link importGeometry} has scaled it). */
export type Point = readonly [number, number];

/** A drawable entity of the flattened drawing, in drawing units, tagged with its layer name. */
export type DxfEntity =
  | { readonly kind: "line"; readonly layer: string; readonly a: Point; readonly b: Point }
  | {
      readonly kind: "polyline";
      readonly layer: string;
      readonly points: readonly Point[];
      readonly closed: boolean;
    }
  | {
      readonly kind: "circle";
      readonly layer: string;
      readonly center: Point;
      readonly radius: number;
    }
  | {
      readonly kind: "arc";
      readonly layer: string;
      readonly center: Point;
      readonly radius: number;
      readonly startDeg: number;
      readonly endDeg: number;
    };

/** A layer of the drawing, with the number of entities it carries after block expansion. */
export interface DxfLayer {
  /**
   * Key of the layer: sanitised, and kept whole up to the DXF name length, so two distinct layers never share a
   * key. Used to look the layer up in the mapping; it is never written into a site map.
   */
  readonly name: string;
  /** Text shown in the mapping table: the key cut to the display limit. */
  readonly label: string;
  /** Entities on this layer, drawn or ignored, after block expansion. */
  readonly entityCount: number;
}

/** The parsed drawing. */
export interface DxfDocument {
  /**
   * The `$INSUNITS` header value, or `null` when absent. A code the console does not convert is kept as read;
   * the scale is then given by the operator (see `metresPerUnit` in `units.ts`).
   */
  readonly insUnits: number | null;
  /** Layers that carry at least one entity, in order of first appearance. */
  readonly layers: readonly DxfLayer[];
  /** Drawable entities with their block insertions applied. */
  readonly entities: readonly DxfEntity[];
  /** Entities that were read but not drawn, counted by DXF type or by the reason they were skipped. */
  readonly ignored: Readonly<Record<string, number>>;
}

/** Reasons a DXF import is refused. Each code has an i18n message in the UI. */
export const DXF_ERROR_CODES = [
  "too-large",
  "binary",
  "not-dxf",
  "wrong-type",
  "too-complex",
  "empty",
  "timeout",
] as const;

/** A refusal code of the DXF import. */
export type DxfErrorCode = (typeof DXF_ERROR_CODES)[number];

/**
 * Tells whether a value is a known refusal code. Used when a code arrives from the worker.
 *
 * @param value - Candidate code.
 * @returns `true` when the value is one of {@link DXF_ERROR_CODES}.
 */
export function isDxfErrorCode(value: unknown): value is DxfErrorCode {
  return typeof value === "string" && (DXF_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Hard limits of the import. Each one bounds the work a hostile file can cause, so a parse always ends.
 * `maxExpandedVertices` bounds the vertices produced by block insertions, which `maxExpandedEntities` alone
 * would not bound: one polyline inserted many times is cheap to store and expensive to place.
 */
export const DXF_LIMITS = {
  maxBytes: 20_000_000,
  maxPairs: 2_000_000,
  maxEntities: 200_000,
  maxExpandedEntities: 300_000,
  maxExpandedVertices: 2_000_000,
  maxLayers: 500,
  /** Longest layer key kept. DXF itself caps a layer name at 255 characters, so nothing legitimate is cut. */
  maxLayerKeyLength: 255,
  /** Longest layer name shown in the mapping table. Longer keys are cut for display only. */
  maxLayerNameLength: 64,
  maxVerticesPerPolyline: 50_000,
  timeoutMs: 15_000,
} as const;

/** Failure of the DXF import, with a code the UI maps to a message. */
export class DxfError extends Error {
  /** Why the import was refused. */
  readonly code: DxfErrorCode;

  /**
   * @param code - Refusal code.
   */
  constructor(code: DxfErrorCode) {
    super(`DXF import refused: ${code}`);
    this.name = "DxfError";
    this.code = code;
  }
}
