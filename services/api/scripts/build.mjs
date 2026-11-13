// @ts-check
/**
 * Bundles every Lambda handler in `src/handlers/` into `dist/<name>/index.mjs`.
 *
 * One self-contained bundle per handler, with the AWS SDK inside it: each function ships only what
 * it imports, and no `node_modules` tree is needed at runtime. The target is `node24`, the runtime
 * pinned in `.nvmrc`, so the bundle never uses syntax or APIs the Lambda runtime lacks.
 *
 * `dist/` is cleaned before the handler list is checked, so a removed handler cannot leave a stale
 * bundle behind for deployment. With no handler yet, the script reports it and exits successfully:
 * the API ships with its first handler in M2, and the workspace build must stay green until then.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Root of the API package, the parent of `scripts/`. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Prepended to every bundle. A CommonJS dependency bundled into an ES module calls `require` through
 * esbuild's shim, and an ES module has no `require`, so the call would throw on Lambda. Defining
 * `require` here makes the shim work.
 */
const esmRequireBanner =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

/**
 * Lists the handler entry points by file name, without the `.ts` extension.
 *
 * A missing handlers folder means there are no handlers yet, not an error. Declaration files are
 * not handlers.
 *
 * @param {string} handlersDir Absolute path of the `src/handlers` folder.
 * @returns {Promise<string[]>} Sorted handler names, so the build order is deterministic.
 */
export async function listHandlers(handlersDir) {
  let entries;
  try {
    entries = await readdir(handlersDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => entry.name.slice(0, -".ts".length))
    .sort();
}

/**
 * Cleans `dist/`, then bundles every handler of the package at `root`.
 *
 * @param {string} root Package root that holds `src/handlers/` and receives `dist/`.
 * @returns {Promise<string[]>} The names of the handlers built; empty when there is none.
 */
export async function buildHandlers(root) {
  const names = await listHandlers(path.join(root, "src", "handlers"));
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  if (names.length === 0) {
    return names;
  }

  await build({
    absWorkingDir: root,
    entryPoints: names.map((name) => ({
      in: path.join("src", "handlers", `${name}.ts`),
      out: `${name}/index`,
    })),
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    platform: "node",
    target: "node24",
    format: "esm",
    bundle: true,
    banner: { js: esmRequireBanner },
    minify: true,
    sourcemap: true,
    logLevel: "warning",
  });
  return names;
}

/**
 * Command-line entry: builds the handlers of this package and reports the result.
 *
 * @returns {Promise<void>} Resolves once the bundles are written, or the nothing-to-build line is printed.
 */
async function main() {
  const names = await buildHandlers(packageRoot);
  if (names.length === 0) {
    console.log("no Lambda handlers yet");
    return;
  }
  console.log(`built ${names.length} Lambda handler(s): ${names.join(", ")}`);
}

// Runs only when this file is the entry point, so the tests can import the functions without a build.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Build failures are developer-facing; the message is enough, and a stack trace is noise here.
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
