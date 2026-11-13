/**
 * Unit tests of the e2e report scanner: a clean report passes, a leaked password is found in every encoding, short
 * values are ignored, and a hit removes the report. Run by `make check-ts` with `node --test`.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths are built under a fresh temporary directory of this test */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findLeaks, isCompressed, runScan } from "./e2e-scan-report.mjs";

/** A password shaped like the generated ones: base64 characters plus the policy suffix. */
const PASSWORD = "Abc/def+ghi123Aa1!";
const TEMPORARY = "Zyx9+/wvuTSR987Aa1!";
const SCANNER = fileURLToPath(new URL("./e2e-scan-report.mjs", import.meta.url));

/**
 * Builds a file map from path/content pairs.
 *
 * @param {Record<string, string>} entries - Relative path to content.
 * @returns {Map<string, string>} The map findLeaks reads.
 */
function filesOf(entries) {
  return new Map(Object.entries(entries));
}

describe("findLeaks", () => {
  it("returns no path for a clean report", () => {
    assert.deepEqual(
      findLeaks(filesOf({ "index.html": "<p>Robots</p>" }), [PASSWORD, TEMPORARY]),
      [],
    );
  });

  it("returns the path of the file that holds the password", () => {
    const files = filesOf({ "index.html": "<p>ok</p>", "data/log.json": `{"step":"${PASSWORD}"}` });
    assert.deepEqual(findLeaks(files, [PASSWORD]), ["data/log.json"]);
  });

  it("finds the URL-encoded form", () => {
    const encoded = encodeURIComponent(PASSWORD);
    assert.notEqual(encoded, PASSWORD);
    assert.deepEqual(findLeaks(filesOf({ "a.html": `q=${encoded}` }), [PASSWORD]), ["a.html"]);
  });

  it("finds the base64 form", () => {
    const encoded = Buffer.from(PASSWORD, "utf8").toString("base64");
    assert.deepEqual(findLeaks(filesOf({ "a.html": `data:${encoded}` }), [PASSWORD]), ["a.html"]);
  });

  it("ignores secrets shorter than eight characters", () => {
    assert.deepEqual(findLeaks(filesOf({ "a.html": "short abc123" }), ["abc123"]), []);
  });
});

describe("runScan", () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mfc-scan-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Writes a state file with the two password fields, and a report directory with the given files.
   *
   * @param {string} name - Sub-directory of the test root.
   * @param {Record<string, string>} report - Relative path to content of the report.
   * @returns {{ statePath: string, reportDir: string }} The created paths.
   */
  function fixture(name, report) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ temporaryPassword: TEMPORARY, password: PASSWORD, robotId: "e2e-01" }),
    );
    const reportDir = join(dir, "report");
    for (const [path, content] of Object.entries(report)) {
      const target = join(reportDir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    return { statePath, reportDir };
  }

  it("returns 0 and keeps a clean report", () => {
    const { statePath, reportDir } = fixture("clean", { "index.html": "<p>ok</p>" });
    assert.equal(
      runScan(statePath, reportDir, () => {}),
      0,
    );
    assert.equal(existsSync(join(reportDir, "index.html")), true);
  });

  it("returns 0 when there is no report", () => {
    const { statePath } = fixture("no-report", {});
    assert.equal(
      runScan(statePath, join(root, "no-report", "missing"), () => {}),
      0,
    );
  });

  it("deletes the report and returns 1 when a secret is found", () => {
    const { statePath, reportDir } = fixture("leak", {
      "index.html": "<p>ok</p>",
      "steps/a.txt": PASSWORD,
    });
    const lines = [];
    assert.equal(
      runScan(statePath, reportDir, (line) => lines.push(line)),
      1,
    );
    assert.equal(existsSync(reportDir), false);
    assert.ok(lines.some((line) => line.includes("steps/a.txt")));
    assert.ok(!lines.some((line) => line.includes(PASSWORD)), "the log never prints a secret");
  });

  it("deletes the report and returns 1 when the report holds a symbolic link", () => {
    const { statePath, reportDir } = fixture("link", { "index.html": "<p>ok</p>" });
    symlinkSync(statePath, join(reportDir, "link.txt"));
    assert.equal(
      runScan(statePath, reportDir, () => {}),
      1,
    );
    assert.equal(existsSync(reportDir), false);
  });

  it("deletes the report and returns 1 when the state file cannot be read", () => {
    const { reportDir } = fixture("bad-state", { "index.html": "<p>ok</p>" });
    const statePath = join(root, "bad-state", "missing.json");
    assert.equal(
      runScan(statePath, reportDir, () => {}),
      1,
    );
    assert.equal(existsSync(reportDir), false);
  });

  it("deletes the report when a password is in a JUnit XML report", () => {
    const junit =
      `<?xml version="1.0"?><testsuites><testsuite name="demo"><testcase name="sign-in">` +
      `<failure message="expected value ${PASSWORD}"/></testcase></testsuite></testsuites>`;
    const { statePath, reportDir } = fixture("junit", { "results.xml": junit });
    const lines = [];
    assert.equal(
      runScan(statePath, reportDir, (line) => lines.push(line)),
      1,
    );
    assert.equal(existsSync(reportDir), false);
    assert.ok(lines.some((line) => line.includes("results.xml")));
  });

  it("deletes the report when it holds a zip archive, whose content cannot be scanned", () => {
    const { statePath, reportDir } = fixture("zip", { "index.html": "<p>ok</p>" });
    writeFileSync(join(reportDir, "report.zip"), Buffer.from("PK\u0003\u0004 compressed body"));
    assert.equal(
      runScan(statePath, reportDir, () => {}),
      1,
    );
    assert.equal(existsSync(reportDir), false);
  });

  it("recognises zip and gzip magic numbers only", () => {
    assert.equal(isCompressed("PK\u0003\u0004rest"), true);
    assert.equal(isCompressed("\u001f\u008bgzip"), true);
    assert.equal(isCompressed("<html>"), false);
  });

  it("warns about a short secret and still scans the others", () => {
    const dir = join(root, "short");
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ temporaryPassword: "abc", password: PASSWORD }));
    const reportDir = join(dir, "report");
    mkdirSync(reportDir);
    writeFileSync(join(reportDir, "a.txt"), PASSWORD);
    const lines = [];
    assert.equal(
      runScan(statePath, reportDir, (line) => lines.push(line)),
      1,
    );
    assert.ok(lines.some((line) => line.startsWith("warning: 1 secret(s) shorter than 8")));
  });
});

describe("e2e-scan-report CLI", () => {
  it("exits 2 with a usage message when an argument is missing", () => {
    const result = spawnSync(process.execPath, [SCANNER], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  });

  it("exits 1 and deletes the report on a hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfc-scan-cli-"));
    try {
      const statePath = join(dir, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({ temporaryPassword: TEMPORARY, password: PASSWORD }),
      );
      const reportDir = join(dir, "report");
      mkdirSync(reportDir);
      writeFileSync(join(reportDir, "trace.txt"), `leak ${TEMPORARY}`);
      const result = spawnSync(process.execPath, [SCANNER, statePath, reportDir], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /trace\.txt/);
      assert.ok(!result.stderr.includes(TEMPORARY));
      assert.equal(existsSync(reportDir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 for a clean report", () => {
    const dir = mkdtempSync(join(tmpdir(), "mfc-scan-ok-"));
    try {
      const statePath = join(dir, "state.json");
      writeFileSync(
        statePath,
        JSON.stringify({ temporaryPassword: TEMPORARY, password: PASSWORD }),
      );
      const reportDir = join(dir, "report");
      mkdirSync(reportDir);
      writeFileSync(join(reportDir, "index.html"), "<p>ok</p>");
      execFileSync(process.execPath, [SCANNER, statePath, reportDir], { stdio: "ignore" });
      assert.equal(existsSync(reportDir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
