#!/usr/bin/env node
/**
 * Post-build guard: fails when the console bundle contains the end-to-end fixture marker.
 *
 * The fake authentication client accepts fixture accounts. It must never reach a production bundle, even if the
 * build flags were set by mistake. `vite.config.ts` already refuses the flag outside the e2e mode; this scan is
 * the second, independent check on the output that is published.
 *
 * Usage: `node scripts/check-console-fixtures.mjs [path/to/dist]`. Defaults to the console build output.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal `FIXTURE_MARKER` in `apps/console/src/auth/fake-auth-client.ts`; a unit test checks it. */
export const FIXTURE_MARKER = "mfc-e2e-fixture-v1";

/** The built console, relative to this script. */
const DEFAULT_DIR = fileURLToPath(new URL("../apps/console/dist", import.meta.url));

/**
 * Lists the files under a directory, recursively.
 *
 * @param dir - Directory to walk.
 * @returns The paths of the regular files found.
 */
export function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Finds the files of a build that contain the fixture marker.
 *
 * @param dir - Build output directory.
 * @returns The paths of the offending files.
 */
export function findFixtureFiles(dir) {
  return listFiles(dir).filter((path) => readFileSync(path, "utf8").includes(FIXTURE_MARKER));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  try {
    const offenders = findFixtureFiles(dir);
    if (offenders.length > 0) {
      for (const path of offenders) {
        console.error(`FAIL: end-to-end fixture found in ${path}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`check-console-fixtures: no fixture marker in ${dir}`);
    }
  } catch {
    console.error(`FAIL: cannot scan ${dir}; run the console build first`);
    process.exitCode = 1;
  }
}
