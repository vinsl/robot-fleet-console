/**
 * Layer role suggestions: whole-word matching on the layer name, so that a substring never decides a role.
 */
import { describe, expect, it } from "vitest";
import { layerRoles, suggestMapping, type LayerRole } from "../../../src/site/dxf/layer-mapping";

/**
 * Suggested role of one layer name.
 *
 * @param name - The layer name.
 * @returns The role the console proposes.
 */
function roleOf(name: string): LayerRole | undefined {
  return layerRoles(suggestMapping([{ name, label: name, entityCount: 1 }])).get(name);
}

describe("suggestMapping", () => {
  it.each<[string, LayerRole]>([
    ["WALL_EXT", "wall"],
    ["A-WALL", "wall"],
    ["Mur extérieur", "wall"],
    ["contours", "wall"],
    ["RACKS_A", "obstacle"],
    ["Rack-01", "obstacle"],
    ["PalletRacks", "obstacle"],
    ["Équipement", "obstacle"],
    ["shelves", "obstacle"],
    ["0", "ignore"],
    ["TEXT", "ignore"],
  ])("suggests the role of %j from whole words", (name, role) => {
    expect(roleOf(name)).toBe(role);
  });

  it.each(["track", "trackers", "wallpaper", "backwall", "rackety"])(
    "does not match %j, which only contains a keyword",
    (name) => {
      expect(roleOf(name)).toBe("ignore");
    },
  );

  it("gives one entry per layer, keyed by the exact layer name", () => {
    const mapping = suggestMapping([
      { name: "WALLS", label: "WALLS", entityCount: 2 },
      { name: "track", label: "track", entityCount: 1 },
    ]);
    expect(mapping).toEqual({ WALLS: "wall", track: "ignore" });
  });

  it("looks up a layer by name without reaching an inherited property", () => {
    const roles = layerRoles(suggestMapping([{ name: "WALLS", label: "WALLS", entityCount: 1 }]));
    expect(roles.get("constructor")).toBeUndefined();
    expect(roles.get("WALLS")).toBe("wall");
  });
});
