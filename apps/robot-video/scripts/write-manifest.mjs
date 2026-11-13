/**
 * Writes `MANIFEST.sha256` for the built video page: one line per file, `<sha256 hex>  <path>`,
 * sorted by path, paths relative to the folder and with `/` separators.
 *
 * The agent verifies every listed file against this manifest before it serves anything (ADR 0037),
 * so the manifest must list every file of the build, the vendored SDK and its licences included. A
 * symbolic link is refused: the build never produces one, and the agent refuses one too.
 *
 * Usage: `node scripts/write-manifest.mjs [directory]`. The default is the agent's static folder.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Name of the manifest file, written at the top of the folder. */
const MANIFEST_NAME = "MANIFEST.sha256";

/** The folder used when none is given: the agent's static folder, next to this package. */
const DEFAULT_DIRECTORY = fileURLToPath(
  new URL("../../../agent/src/fleet_agent/video/static", import.meta.url),
);

/**
 * Lists every regular file under a folder, recursively.
 *
 * @param root - The folder to walk.
 * @param prefix - The path of `root` relative to the walk's start, empty at the top.
 * @returns The relative paths with `/` separators.
 * @throws {Error} When an entry is a symbolic link or is neither a file nor a folder.
 */
async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic link in the build: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`not a regular file in the build: ${relative}`);
    }
  }
  return files;
}

/**
 * Computes the manifest of a folder and writes it.
 *
 * @param directory - The folder to hash. The manifest itself is not listed.
 */
export async function writeManifest(directory) {
  const files = (await listFiles(directory)).filter((name) => name !== MANIFEST_NAME);
  files.sort();
  const lines = [];
  for (const name of files) {
    const digest = createHash("sha256")
      .update(await readFile(path.join(directory, name)))
      .digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(path.join(directory, MANIFEST_NAME), `${lines.join("\n")}\n`);
  return lines.length;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const directory = process.argv[2] ?? DEFAULT_DIRECTORY;
  const count = await writeManifest(directory);
  console.log(`${MANIFEST_NAME}: ${String(count)} files in ${directory}`);
}
