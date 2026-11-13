/**
 * Tests of the handler build script: the handler listing, the cleaning of `dist/`, and the bundle of
 * a CommonJS dependency that calls `require` at run time, which only works with the banner.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHandlers, listHandlers } from "../../scripts/build.mjs";

describe("build script", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mfc-build-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("listHandlers", () => {
    it("returns no handler when the handlers folder does not exist", async () => {
      await expect(listHandlers(path.join(root, "src", "handlers"))).resolves.toEqual([]);
    });

    it("lists the TypeScript handlers by name, sorted, and skips declarations and other files", async () => {
      const dir = path.join(root, "src", "handlers");
      await mkdir(dir, { recursive: true });
      for (const file of ["robots.ts", "health.ts", "types.d.ts", "notes.md", "legacy.js"]) {
        await writeFile(path.join(dir, file), "export {};\n");
      }

      await expect(listHandlers(dir)).resolves.toEqual(["health", "robots"]);
    });
  });

  describe("buildHandlers", () => {
    it("removes a stale dist folder when there is no handler", async () => {
      await mkdir(path.join(root, "dist", "removed"), { recursive: true });
      await writeFile(path.join(root, "dist", "removed", "index.mjs"), "stale\n");

      await expect(buildHandlers(root)).resolves.toEqual([]);

      await expect(stat(path.join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("bundles a handler whose CommonJS dependency calls require at run time", async () => {
      await mkdir(path.join(root, "src", "handlers"), { recursive: true });
      await writeFile(
        path.join(root, "src", "legacy.cjs"),
        "module.exports = { basename: (p) => require('node:path').basename(p) };\n",
      );
      await writeFile(
        path.join(root, "src", "handlers", "probe.ts"),
        'import legacy from "../legacy.cjs";\nexport const handler = (): string => legacy.basename("/a/b.txt");\n',
      );

      await expect(buildHandlers(root)).resolves.toEqual(["probe"]);

      // The bundle runs in a fresh Node process, as it would on Lambda, so the check is end to end.
      const bundle = pathToFileURL(path.join(root, "dist", "probe", "index.mjs")).href;
      const script = `const { handler } = await import(${JSON.stringify(bundle)}); process.stdout.write(handler());`;
      const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(output).toBe("b.txt");
    });
  });
});
