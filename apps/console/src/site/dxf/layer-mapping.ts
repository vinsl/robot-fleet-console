/**
 * Mapping of drawing layers to the site map roles: walls, obstacles, or ignored.
 *
 * The console proposes a role from the layer name; the operator can change every one before the import runs.
 * A layer that is not in the mapping is ignored, so an unknown layer never adds geometry by surprise.
 */
import type { DxfLayer } from "./types";

/** Role of a drawing layer in the site map. */
export type LayerRole = "wall" | "obstacle" | "ignore";

/** Role of every layer, by layer name. */
export type LayerMapping = Readonly<Record<string, LayerRole>>;

/** Words that usually name the building outline, English and French. A layer matches on a whole word only. */
const WALL_WORDS: ReadonlySet<string> = new Set([
  "wall",
  "walls",
  "mur",
  "murs",
  "outline",
  "outlines",
  "contour",
  "contours",
]);

/** Words that usually name racks, machines and other fixed equipment, English and French. */
const OBSTACLE_WORDS: ReadonlySet<string> = new Set([
  "rack",
  "racks",
  "shelf",
  "shelves",
  "storage",
  "machine",
  "machines",
  "machinery",
  "equipment",
  "equip",
  "équipement",
  "équipements",
  "obstacle",
  "obstacles",
]);

/**
 * Splits a layer name into lower-case words. Letters of any script are kept together, and a camel-case join
 * (`PalletRacks`) splits in two, so the words are the ones a person reads.
 *
 * @param name - The layer name.
 * @returns The words, in order; empty for a name without letters.
 */
function wordsOf(name: string): string[] {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word !== "");
}

/**
 * Proposes a role for one layer from its name. Matching is on whole words, so a layer named `track` does not
 * count as `rack`, and `wallpaper` does not count as `wall`.
 *
 * @param name - The layer name.
 * @returns The suggested role.
 */
function suggestRole(name: string): LayerRole {
  const words = wordsOf(name);
  if (words.some((word) => WALL_WORDS.has(word))) {
    return "wall";
  }
  if (words.some((word) => OBSTACLE_WORDS.has(word))) {
    return "obstacle";
  }
  return "ignore";
}

/**
 * Proposes a mapping for every layer of a drawing.
 *
 * @param layers - The layers of the parsed drawing.
 * @returns A mapping with one entry per layer.
 */
export function suggestMapping(layers: readonly DxfLayer[]): LayerMapping {
  // Object.fromEntries defines own properties, so a layer named `__proto__` cannot alter the prototype.
  return Object.fromEntries(layers.map((layer) => [layer.name, suggestRole(layer.name)]));
}

/**
 * Indexes a mapping for lookups by layer name. A `Map` is used so that a layer named `constructor` cannot
 * reach an inherited property; a layer missing from the mapping has the role `ignore` at the call site.
 *
 * @param mapping - The mapping.
 * @returns The roles by layer name.
 */
export function layerRoles(mapping: LayerMapping): ReadonlyMap<string, LayerRole> {
  return new Map(Object.entries(mapping));
}
