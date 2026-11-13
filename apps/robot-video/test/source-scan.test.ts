/**
 * Denied-capability scan of the page source (ADR 0036, threat T24).
 *
 * The page may only call the agent's three routes. It must not send a command, open the MQTT
 * transport, persist a credential, or write markup from the network. Each forbidden capability is
 * listed here, and the scan fails on the first occurrence in `src/`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Folder of the page source, resolved from this file. */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Capabilities the page must never use, with the reason in the name of each. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["markup from a string (XSS)", /innerHTML|outerHTML|insertAdjacentHTML/],
  ["dynamic code", /\beval\(|new Function\b/],
  ["persistent storage of credentials", /localStorage|sessionStorage|document\.cookie/],
  ["a legacy request API", /XMLHttpRequest/],
  ["a beacon to another place", /sendBeacon/],
  ["a command route", /\/cmd\b/],
  ["the MQTT transport", /mqtt/i],
];

/**
 * Lists every TypeScript and CSS file under a folder.
 *
 * @param folder - The folder to walk.
 * @returns The absolute paths of the files.
 */
function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|css)$/.test(name) ? [path] : [];
  });
}

describe("page source", () => {
  const files = sourceFiles(SRC);

  it("contains source files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN)("does not use %s", (_reason, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
