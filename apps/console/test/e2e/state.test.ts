/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths are built under a fresh temporary directory of this test */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadState, parseState } from "../../e2e/support/state";

/** A state file with every field the setup script writes, with fake values. */
const VALID = {
  consoleUrl: "https://console.example.com",
  region: "eu-west-3",
  userPoolId: "eu-west-3_AAAAAAAAA",
  siteId: "paris-01",
  email: "e2e-1-1@example.com",
  temporaryPassword: "TempSecret123Aa1!",
  password: "NewSecret123Aa1!",
  robotId: "e2e1a1-01",
  robotName: "E2E 1a1",
  simPid: 4242,
  simStart: 123456,
  consumerWasEnabled: false,
};

/** Message the loader throws for any invalid state, without the content. */
const FIXED_MESSAGE = "E2E_STATE_FILE is not set or invalid";

describe("parseState", () => {
  it("accepts the state the setup script writes", () => {
    expect(parseState(VALID)).toEqual(VALID);
  });

  it.each([
    ["a missing key", { ...VALID, robotId: undefined }],
    ["an extra key", { ...VALID, unexpected: "x" }],
    ["a non-https console URL", { ...VALID, consoleUrl: "http://console.example.com" }],
    ["an empty password", { ...VALID, password: "" }],
    ["a non-integer simulator pid", { ...VALID, simPid: 1.5 }],
    ["a missing simulator start time", { ...VALID, simStart: undefined }],
    ["a missing consumer state", { ...VALID, consumerWasEnabled: undefined }],
    ["a consumer state that is not a boolean", { ...VALID, consumerWasEnabled: "false" }],
    ["a region outside the shell pattern", { ...VALID, region: "EU-WEST-3" }],
    ["a pool id outside the shell pattern", { ...VALID, userPoolId: "pool" }],
    ["an e-mail outside the e2e shape", { ...VALID, email: "ceo@example.com" }],
    ["a robot id outside the e2e shape", { ...VALID, robotId: "sim-01" }],
    ["another site", { ...VALID, siteId: "lyon-01" }],
    ["a value that is not an object", "not an object"],
  ])("refuses %s with a fixed message that holds no value", (_label, raw) => {
    let thrown: unknown;
    try {
      parseState(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe(FIXED_MESSAGE);
    expect(message).not.toContain(VALID.password);
    expect(message).not.toContain(VALID.temporaryPassword);
  });
});

describe("loadState", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mfc-e2e-state-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and validates the file", () => {
    const path = join(dir, "valid.json");
    writeFileSync(path, JSON.stringify(VALID));
    expect(loadState(path)).toEqual(VALID);
  });

  it("reads the path from E2E_STATE_FILE when no path is given", () => {
    const path = join(dir, "env.json");
    writeFileSync(path, JSON.stringify(VALID));
    const previous = process.env["E2E_STATE_FILE"];
    process.env["E2E_STATE_FILE"] = path;
    try {
      expect(loadState()).toEqual(VALID);
    } finally {
      if (previous === undefined) {
        delete process.env["E2E_STATE_FILE"];
      } else {
        process.env["E2E_STATE_FILE"] = previous;
      }
    }
  });

  it("refuses an unset path with the fixed message", () => {
    expect(() => loadState("")).toThrow(FIXED_MESSAGE);
    expect(() => loadState(undefined)).toThrow(FIXED_MESSAGE);
  });

  it("refuses a file that is not JSON without showing its content", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, `{"password": "${VALID.password}"`);
    let message = "";
    try {
      loadState(path);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe(FIXED_MESSAGE);
    expect(message).not.toContain(VALID.password);
  });

  it("refuses a missing file with the fixed message", () => {
    expect(() => loadState(join(dir, "missing.json"))).toThrow(FIXED_MESSAGE);
  });
});
