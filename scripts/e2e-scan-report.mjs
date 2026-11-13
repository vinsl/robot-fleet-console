#!/usr/bin/env node
/**
 * Secret scan of the Playwright report of the deployed e2e run (ADR 0069, D8).
 *
 * The report is uploaded as a CI artifact when the run fails, so a secret printed in it would leave the runner. The
 * scan looks for the ephemeral passwords of the run in the raw, URL-encoded and base64 forms. A hit deletes the whole
 * report, because a partial report is not worth keeping next to a leaked secret, and the job fails.
 *
 * Limits, stated so that nobody relies on more than the scan does:
 * - Only the two passwords of the state file are scanned. The TOTP secret is typed by the test and kept in memory, so
 *   it never reaches the state file. A Playwright error-context snapshot of the enrolment page could show it. Scanning
 *   it needs the spec to write the secret to a private file in the state directory, which is a follow-up of S6.
 * - Compressed files (zip, gzip) cannot be read, so their presence fails the scan. The HTML reporter is therefore off.
 *
 * Usage: `node scripts/e2e-scan-report.mjs <state.json> <report-dir>`.
 * Exit status: 0 clean or no report, 1 a secret was found or the scan could not run, 2 usage error.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- the paths are CLI arguments chosen by make e2e, not request input */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shorter values are not scanned: a one-character "secret" would match almost any report. The generated passwords
 * are always longer, so a skipped value is reported on stderr rather than trusted silently.
 */
export const MIN_SECRET_LENGTH = 8;

/** The state fields that hold a secret. Other fields are not secrets and are not scanned. */
const SECRET_FIELDS = ["temporaryPassword", "password"];

/**
 * Lists the relative paths of the files that contain one of the secrets, in raw, URL-encoded or base64 form.
 *
 * The base64 form is the plain encoding of the secret from its first byte; a secret embedded at another byte
 * offset inside a larger base64 blob is not found. The report holds step names only (no trace, no screenshot,
 * ADR 0069 D7), so the cheaper check is the one that matters.
 *
 * @param {ReadonlyMap<string, string>} files - Map of relative path to file content, read as latin1 so that bytes
 *   map one to one.
 * @param {readonly string[]} secrets - The secret values of the run; those shorter than MIN_SECRET_LENGTH are ignored.
 * @returns {string[]} The paths that leak a secret, in the order of the map.
 */
export function findLeaks(files, secrets) {
  const forms = secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("base64"),
    ]);
  const leaks = [];
  for (const [path, content] of files) {
    if (forms.some((form) => content.includes(form))) {
      leaks.push(path);
    }
  }
  return leaks;
}

/**
 * Tells whether a file is a zip or gzip archive, by its magic number. Its content would be compressed, so a secret
 * inside it could not be matched; the scan treats it as a finding.
 *
 * @param {string} content - The file content, as latin1.
 * @returns {boolean} True for a zip (PK) or gzip archive.
 */
export function isCompressed(content) {
  return content.startsWith("PK\u0003\u0004") || content.startsWith("\u001f\u008b");
}

/**
 * Reads every regular file under a directory. Symbolic links and other special entries are not followed and are
 * returned apart: a link can point outside the report, so the scan fails closed on it.
 *
 * @param {string} root - Directory to walk.
 * @returns {{ files: Map<string, string>, unexpected: string[] }} The file contents by relative path, and the relative
 *   paths of the entries that are not regular files or directories.
 */
export function collectReport(root) {
  const files = new Map();
  const unexpected = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        // latin1 keeps every byte as one character, so a byte pattern of an ASCII secret matches the same bytes.
        files.set(relative(root, full), readFileSync(full, "latin1"));
      } else {
        unexpected.push(relative(root, full));
      }
    }
  };
  walk(root);
  return { files, unexpected };
}

/**
 * Reads the secret values from the e2e state file. Only the two password fields are used; the state file is never
 * printed, and a parse error does not show its content.
 *
 * @param {string} statePath - Path of state.json written by the e2e setup script.
 * @returns {string[]} The two secret values.
 * @throws {Error} When the file cannot be read or is not a JSON object with string fields.
 */
export function readSecrets(statePath) {
  const parsed = JSON.parse(readFileSync(statePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the e2e state file is not a JSON object");
  }
  return SECRET_FIELDS.map((field) => {
    const value = Reflect.get(parsed, field);
    if (typeof value !== "string") {
      throw new Error(`the e2e state file has no ${field}`);
    }
    return value;
  });
}

/**
 * Runs the scan and, on a hit or an error, removes the report.
 *
 * @param {string} statePath - Path of state.json.
 * @param {string} reportDir - Path of the Playwright report directory.
 * @param {(line: string) => void} log - Receives the messages, one line each; never a secret.
 * @returns {number} The process exit code.
 */
export function runScan(statePath, reportDir, log) {
  if (!existsSync(reportDir)) {
    return 0;
  }
  try {
    const secrets = readSecrets(statePath);
    const skipped = secrets.filter((secret) => secret.length < MIN_SECRET_LENGTH).length;
    if (skipped > 0) {
      log(
        `warning: ${skipped} secret(s) shorter than ${MIN_SECRET_LENGTH} characters were not scanned`,
      );
    }
    const { files, unexpected } = collectReport(reportDir);
    const compressed = [...files]
      .filter(([, content]) => isCompressed(content))
      .map(([path]) => path);
    const leaks = [...findLeaks(files, secrets), ...unexpected, ...compressed];
    if (leaks.length === 0) {
      return 0;
    }
    rmSync(reportDir, { recursive: true, force: true });
    log(
      `FAIL: a secret or an unexpected entry was found in the e2e report; the report is deleted. Files: ${leaks.join(", ")}`,
    );
    return 1;
  } catch {
    // The report cannot be checked, so it is not kept: a failed scan must not leave an unchecked report behind.
    rmSync(reportDir, { recursive: true, force: true });
    log("FAIL: the e2e report could not be scanned; the report is deleted");
    return 1;
  }
}

/**
 * Entry point: checks the arguments, then scans.
 *
 * @param {readonly string[]} argv - The process arguments after the script name.
 * @returns {number} The process exit code.
 */
export function main(argv) {
  const [statePath, reportDir] = argv;
  if (argv.length !== 2 || statePath === undefined || reportDir === undefined) {
    console.error("usage: node scripts/e2e-scan-report.mjs <state.json> <report-dir>");
    return 2;
  }
  return runScan(statePath, reportDir, (line) => {
    console.error(line);
  });
}

// Runs only when executed directly, so that the unit tests can import the functions without side effects.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
