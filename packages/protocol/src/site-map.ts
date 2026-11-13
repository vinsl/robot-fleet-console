/**
 * Site map: the warehouse layout as GeoJSON in a local metric frame.
 *
 * The console exports it, the simulator loads it and the planner routes around it, so the contract
 * is written once here. Coordinates are metres in the site frame (origin at the site reference point),
 * not longitude and latitude: a warehouse is a few hundred metres across, and a metric frame keeps the
 * planner and the operator in the same unit. The `fleet` member names that frame, so a GeoJSON reader
 * that assumes WGS 84 refuses the file instead of drawing it in the wrong place.
 */
import { z } from "zod";

/** Largest accepted text of a site map, in UTF-8 bytes. Checked before parsing, so a huge file costs nothing. */
export const SITE_MAP_MAX_BYTES = 2_000_000;

/** Largest number of features in one map. */
const MAX_FEATURES = 5000;

/** Largest number of positions (vertices) in one map, counting closing positions of rings. */
const MAX_VERTICES = 50_000;

/** Bound of every coordinate, in metres from the origin. Matches the telemetry bound of the robot pose. */
const COORDINATE_BOUND_M = 1000;

/**
 * Largest extent of the map along each axis, in metres. A warehouse larger than this is out of scope. Exported so
 * the console refuses an oversized plan at import, with the same limit the schema applies.
 */
export const MAX_EXTENT_M = 1000;

/** Feature kinds the planner understands. Any other kind is refused rather than ignored. */
export const SiteMapFeatureKindSchema = z.enum([
  "wall",
  "obstacle",
  "charger",
  "workstation",
  "nogo",
]);

/** A validated feature kind. */
export type SiteMapFeatureKind = z.infer<typeof SiteMapFeatureKindSchema>;

/**
 * Grammar of a feature or workstation name: lowercase slug, short enough to show on a label. Names are
 * the only text of a site map that the planner and the console read back, so the grammar keeps them
 * free of markup and control characters by construction.
 */
export const SITE_MAP_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Name of a workstation or a feature, validated against {@link SITE_MAP_NAME_PATTERN}. */
export const SiteMapNameSchema = z.string().regex(SITE_MAP_NAME_PATTERN);

/** A position `[x, y]` in metres. Two elements only: a third element would be an altitude this frame does not have. */
const PositionSchema = z.tuple([
  z.number().min(-COORDINATE_BOUND_M).max(COORDINATE_BOUND_M),
  z.number().min(-COORDINATE_BOUND_M).max(COORDINATE_BOUND_M),
]);

/** A position as a plain pair, shared by the geometry schemas. */
export type Position = z.infer<typeof PositionSchema>;

/** A closed ring: at least four positions, the first equal to the last. */
const ClosedRingSchema = z
  .array(PositionSchema)
  .min(4)
  .refine((ring) => positionsEqual(ring[0], ring[ring.length - 1]), {
    message: "a polygon ring must be closed",
  });

/**
 * Whether two positions are the same point.
 *
 * @param left - First position, defined because it was taken from a non-empty ring.
 * @param right - Second position, defined for the same reason.
 * @returns True when both coordinates are equal.
 */
function positionsEqual(left: Position | undefined, right: Position | undefined): boolean {
  return left !== undefined && right !== undefined && left[0] === right[0] && left[1] === right[1];
}

/** Feature of kind `wall`: a line of at least two positions. */
const WallFeatureSchema = z.strictObject({
  type: z.literal("Feature"),
  geometry: z.strictObject({
    type: z.literal("LineString"),
    coordinates: z.array(PositionSchema).min(2),
  }),
  properties: z.strictObject({ kind: z.literal("wall"), name: SiteMapNameSchema.optional() }),
});

/**
 * Builds the schema of a feature that is one closed polygon ring, for the two area kinds that share
 * that geometry: `obstacle` (a rack, a pillar) and `nogo` (a zone robots must never enter).
 *
 * @param kind - The feature kind the schema accepts.
 * @returns The strict object schema of a feature of that kind.
 */
function areaFeatureSchema<Kind extends "obstacle" | "nogo">(kind: Kind) {
  return z.strictObject({
    type: z.literal("Feature"),
    geometry: z.strictObject({
      type: z.literal("Polygon"),
      coordinates: z.tuple([ClosedRingSchema]),
    }),
    properties: z.strictObject({ kind: z.literal(kind), name: SiteMapNameSchema.optional() }),
  });
}

/** Feature of kind `obstacle`: one closed polygon ring (a rack, a pillar). */
const ObstacleFeatureSchema = areaFeatureSchema("obstacle");

/** Feature of kind `nogo`: one closed polygon ring that robots must never enter. */
const NogoFeatureSchema = areaFeatureSchema("nogo");

/** Feature of kind `charger`: the single point where robots recharge. */
const ChargerFeatureSchema = z.strictObject({
  type: z.literal("Feature"),
  geometry: z.strictObject({ type: z.literal("Point"), coordinates: PositionSchema }),
  properties: z.strictObject({ kind: z.literal("charger"), name: SiteMapNameSchema.optional() }),
});

/** Smallest side of a workstation footprint, in metres. Below it the footprint is a dot, not a footprint. */
export const WORKSTATION_SIZE_MIN_M = 0.1;

/** Largest side of a workstation footprint, in metres. A bay is never wider than this. */
export const WORKSTATION_SIZE_MAX_M = 50;

/**
 * Optional footprint of a workstation: an axis-aligned rectangle centred on the workstation's point.
 * The point stays the mission target; the footprint is what the operator sees and draws. Strict, so an
 * extra key is refused rather than silently kept, and finite by construction (zod refuses NaN and infinity).
 */
export const WorkstationSizeSchema = z.strictObject({
  width: z.number().min(WORKSTATION_SIZE_MIN_M).max(WORKSTATION_SIZE_MAX_M),
  height: z.number().min(WORKSTATION_SIZE_MIN_M).max(WORKSTATION_SIZE_MAX_M),
});

/** A validated workstation footprint, in metres. */
export type WorkstationSize = z.infer<typeof WorkstationSizeSchema>;

/**
 * Feature of kind `workstation`: a named point where a mission starts or ends. The name is required. The
 * optional `size` is a footprint centred on the point; a map without it is valid (version 1 maps have none).
 */
const WorkstationFeatureSchema = z.strictObject({
  type: z.literal("Feature"),
  geometry: z.strictObject({ type: z.literal("Point"), coordinates: PositionSchema }),
  properties: z.strictObject({
    kind: z.literal("workstation"),
    name: SiteMapNameSchema,
    size: WorkstationSizeSchema.optional(),
  }),
});

/** A workstation feature, whose name is always present. */
type WorkstationFeature = z.infer<typeof WorkstationFeatureSchema>;

/**
 * One feature of the map. The union is discriminated by the geometry and the kind together, so a
 * `wall` drawn as a polygon is refused by the schema of its kind.
 */
export const SiteMapFeatureSchema = z.union([
  WallFeatureSchema,
  ObstacleFeatureSchema,
  NogoFeatureSchema,
  ChargerFeatureSchema,
  WorkstationFeatureSchema,
]);

/** A validated feature of a site map. */
export type SiteMapFeature = z.infer<typeof SiteMapFeatureSchema>;

/** A charger feature. */
type ChargerFeature = z.infer<typeof ChargerFeatureSchema>;

/**
 * Whether a feature is the charger. A type guard, so the filter result is typed as the charger kind.
 *
 * @param feature - A validated feature of the map.
 * @returns True when the feature is of kind `charger`.
 */
function isChargerFeature(feature: SiteMapFeature): feature is ChargerFeature {
  return feature.properties.kind === "charger";
}

/**
 * Whether a feature is a workstation. A type guard, so the name is typed as present (it is required by
 * the workstation schema) and needs no fallback when uniqueness is checked.
 *
 * @param feature - A validated feature of the map.
 * @returns True when the feature is of kind `workstation`.
 */
function isWorkstationFeature(feature: SiteMapFeature): feature is WorkstationFeature {
  return feature.properties.kind === "workstation";
}

/**
 * Site map as a GeoJSON FeatureCollection. The cross-feature rules (one charger, at least two
 * workstations with unique names, total size and extent) are checked after the structure.
 */
export const SiteMapSchema = z
  .strictObject({
    type: z.literal("FeatureCollection"),
    fleet: z.strictObject({
      crs: z.literal("local-metric"),
      version: z.int().min(1),
    }),
    features: z.array(SiteMapFeatureSchema).max(MAX_FEATURES),
  })
  .superRefine((map, context) => {
    const chargers = map.features.filter(isChargerFeature);
    if (chargers.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "a site map has exactly one charger",
      });
    }

    const workstations = map.features.filter(isWorkstationFeature);
    if (workstations.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "a site map has at least two workstations",
      });
    }
    const names = workstations.map((workstation) => workstation.properties.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "workstation names are unique",
      });
    }

    const positions = map.features.flatMap(featurePositions);
    if (positions.length > MAX_VERTICES) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "a site map has at most 50 000 positions",
      });
    }
    const extentPoints = map.features.flatMap(extentPositions);
    if (extentPoints.length > 0) {
      const xs = extentPoints.map((position) => position[0]);
      const ys = extentPoints.map((position) => position[1]);
      const extentX = Math.max(...xs) - Math.min(...xs);
      const extentY = Math.max(...ys) - Math.min(...ys);
      if (extentX > MAX_EXTENT_M || extentY > MAX_EXTENT_M) {
        context.addIssue({
          code: "custom",
          path: ["features"],
          message: "a site map is at most 1 000 m across on each axis",
        });
      }
    }
  });

/**
 * Lists every position of one feature, for the size and extent checks and the site summary.
 *
 * @param feature - A validated feature.
 * @returns The positions of its geometry, in order.
 */
export function featurePositions(feature: SiteMapFeature): readonly Position[] {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "LineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates.flat();
  }
}

/**
 * Lists the positions that count towards the map extent. A workstation with a footprint counts the four
 * corners of the footprint, so a bay at the edge of the plan cannot widen the map past the limit unseen.
 * The vertex count and the summary keep using {@link featurePositions}: a footprint is not a vertex.
 *
 * @param feature - A validated feature.
 * @returns The positions of its geometry, with the corners of a workstation footprint added.
 */
function extentPositions(feature: SiteMapFeature): readonly Position[] {
  if (!isWorkstationFeature(feature) || feature.properties.size === undefined) {
    return featurePositions(feature);
  }
  const [x, y] = feature.geometry.coordinates;
  const halfWidth = feature.properties.size.width / 2;
  const halfHeight = feature.properties.size.height / 2;
  return [
    [x - halfWidth, y - halfHeight],
    [x + halfWidth, y - halfHeight],
    [x + halfWidth, y + halfHeight],
    [x - halfWidth, y + halfHeight],
  ];
}

/** A validated site map. */
export type SiteMap = z.infer<typeof SiteMapSchema>;

/**
 * Whether the UTF-8 encoding of a text exceeds the site map size bound.
 *
 * A UTF-16 code unit encodes to one to three UTF-8 bytes, so the text length bounds the byte count from
 * both sides. Only the borderline is encoded, which keeps a huge upload from being copied just to be
 * measured.
 *
 * @param text - The text to measure.
 * @returns True when the text is larger than {@link SITE_MAP_MAX_BYTES} in UTF-8.
 */
function exceedsSiteMapSize(text: string): boolean {
  if (text.length > SITE_MAP_MAX_BYTES) {
    return true;
  }
  if (text.length * 3 <= SITE_MAP_MAX_BYTES) {
    return false;
  }
  return new TextEncoder().encode(text).byteLength > SITE_MAP_MAX_BYTES;
}

/**
 * Parses the text of a site map: size first, then JSON, then the schema.
 *
 * The size check runs before `JSON.parse` so that an oversized upload is refused without being parsed.
 * Every refusal is a `ZodError`, so a caller handles one error type for all three stages.
 *
 * @param text - The GeoJSON document as received.
 * @returns The validated site map.
 * @throws ZodError If the text is too large, is not JSON, or does not satisfy {@link SiteMapSchema}.
 */
export function parseSiteMap(text: string): SiteMap {
  if (exceedsSiteMapSize(text)) {
    throw new z.ZodError([
      { code: "custom", path: [], message: "site map is larger than 2 MB", input: undefined },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser message can echo part of the input, so the refusal states the fact only.
    throw new z.ZodError([
      { code: "custom", path: [], message: "site map is not JSON", input: undefined },
    ]);
  }
  return SiteMapSchema.parse(value);
}
