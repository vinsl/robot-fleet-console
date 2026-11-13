/* eslint-disable security/detect-non-literal-fs-filename -- the paths are built from this test's own source folder, never from input */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The media query of a compact screen: narrow (phone in portrait) or short (phone in landscape), ADR 0075. */
const COMPACT = "@media (max-width: 639px), (max-height: 500px)";

/** Stylesheets that keep a width-only query on purpose, each with its reason. */
const WIDTH_ONLY_ALLOWED: Readonly<Record<string, string>> = {
  "site/editor/Editor.module.css":
    "the editor grid stacks by width: a short wide screen still has room for two columns",
};

const SRC = join(__dirname, "../../src");

/**
 * Lists the CSS files under a folder.
 *
 * @param folder - The folder to walk.
 * @returns The paths of every `.css` file below it.
 */
function cssFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
  });
}

/**
 * Reads a source file with its whitespace collapsed, so the checks do not depend on the formatting.
 *
 * @param path - Path relative to `src`.
 * @returns The text with every run of whitespace replaced by one space.
 */
function squashed(path: string): string {
  return readFileSync(join(SRC, path), "utf8").replace(/\s+/g, " ");
}

describe("compact screens", () => {
  it("treats a short landscape phone like a narrow portrait one", () => {
    const bare = cssFiles(SRC)
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => !(file in WIDTH_ONLY_ALLOWED))
      .filter((file) => /@media \(max-width: ?639px\) ?\{/.test(squashed(file)));
    expect(bare).toEqual([]);
  });

  it("applies the compact query in every stylesheet the ADR names", () => {
    for (const file of [
      "theme/tokens.css",
      "layout/StatusLine.module.css",
      "layout/Dock.module.css",
      "layout/SoundToggle.module.css",
      "alerts/AlertPill.module.css",
      "kpi/KpiCorners.module.css",
    ]) {
      expect(squashed(file), file).toContain(COMPACT);
    }
  });

  it("halves the dock, the map controls and the alert pill on a short landscape screen", () => {
    for (const file of [
      "layout/Dock.module.css",
      "fleet/map/MapControls.module.css",
      "alerts/AlertPill.module.css",
    ]) {
      expect(squashed(file), file).toContain("@media (max-height: 500px) {");
    }
    expect(squashed("alerts/AlertPill.module.css")).toMatch(
      /@media \(max-height: 500px\) \{ \.pill \{ top: auto; bottom:/,
    );
  });

  it("uses the same query for the tilt of the map, which the script decides", () => {
    const script = squashed("fleet/map/geometry-hooks.ts");
    expect(script).toContain("breakpoint.compactHeight");
    expect(script).toContain("(max-height:");
  });
});
