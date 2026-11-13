/**
 * Tests of the live probe `scripts/ws-probe.mjs`, run as an operator runs it: a real Node process through the
 * tsx loader, from the protocol package. The self-test covers the frame checks and the latency statistics
 * against a local fake WebSocket server. The other tests cover the usage errors and the token path, with a
 * stub token script, and they check that the token never reaches the output.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Root of the repository. */
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
/** The probe under test. */
const probe = path.join(repoRoot, "scripts", "ws-probe.mjs");
/** The protocol package: the probe runs from here so that the tsx loader is found. */
const protocolDir = path.join(repoRoot, "packages", "protocol");
/** A token-shaped value that must never reach the output of the probe. */
const TOKEN_SENTINEL = "SecretTokenSentinelForTests".padEnd(43, "x");
const SUB = "11111111-aaaa-4bbb-8ccc-000000000001";

/** Outcome of one run of the probe. */
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Shape of a summary line the tests look at. */
interface Summary {
  readonly verdict: string;
  readonly reasons: readonly string[];
}

/**
 * Narrows a parsed JSON value to the summary shape the tests read.
 * @param value Parsed JSON.
 * @returns Whether the value has a verdict and a reasons list.
 */
function isSummary(value: unknown): value is Summary {
  return (
    typeof value === "object" &&
    value !== null &&
    "verdict" in value &&
    typeof value.verdict === "string" &&
    "reasons" in value &&
    Array.isArray(value.reasons)
  );
}

/**
 * Runs the probe with the given arguments.
 * @param args Command-line arguments.
 * @param env Extra environment, such as the stub token script.
 * @returns The status and the captured output.
 */
function runProbe(args: readonly string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", probe, ...args], {
    cwd: protocolDir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("ws-probe self-test", () => {
  it("passes the four scenarios against the fake server", () => {
    const result = runProbe(["--self-test"]);
    expect(result.status).toBe(0);
    const outcome = JSON.parse(result.stdout) as unknown;
    expect(outcome).toEqual({
      selfTest: "PASS",
      scenarios: {
        healthy: "PASS",
        "invalid-frame": "PASS",
        "latency-above-threshold": "PASS",
        "refused-handshake": "PASS",
      },
    });
  }, 60_000);
});

describe("ws-probe usage", () => {
  const usageCases: [string, string[]][] = [
    [
      "an unknown option",
      ["--site-id", "paris-01", "--sub", SUB, "--role", "Operator", "--bogus", "1"],
    ],
    ["a site that is not valid", ["--site-id", "Paris 01", "--sub", SUB, "--role", "Operator"]],
    [
      "a role that is not in the protocol",
      ["--site-id", "paris-01", "--sub", SUB, "--role", "Boss"],
    ],
    ["a missing subject", ["--site-id", "paris-01", "--role", "Operator"]],
    [
      "a zero duration",
      ["--site-id", "paris-01", "--sub", SUB, "--role", "Operator", "--seconds", "0"],
    ],
    [
      "a warm-up not shorter than the run",
      [
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--seconds",
        "60",
        "--warmup-seconds",
        "60",
      ],
    ],
    [
      "an option given twice",
      ["--site-id", "paris-01", "--site-id", "paris-02", "--sub", SUB, "--role", "Operator"],
    ],
  ];

  it.each(usageCases)("refuses %s with status 2", (_label, args) => {
    const result = runProbe(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("ws-probe token path", () => {
  let sandbox: string;
  const probeArgs = [
    "--site-id",
    "paris-01",
    "--sub",
    SUB,
    "--role",
    "Operator",
    "--seconds",
    "1",
    "--warmup-seconds",
    "0",
  ];

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "ws-probe-test-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  /**
   * Writes a stub token script with the given body and makes it executable.
   * @param name File name of the stub.
   * @param body Shell body after the shebang.
   * @returns Absolute path of the stub.
   */
  async function stub(name: string, body: string): Promise<string> {
    const file = path.join(sandbox, name);
    await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(file, 0o700);
    return file;
  }

  it("reports TOKEN_UNAVAILABLE when the token script fails, without repeating its output", async () => {
    const script = await stub("fail.sh", `echo "request ${TOKEN_SENTINEL}" >&2\nexit 1`);
    const result = runProbe(probeArgs, { WS_PROBE_TOKEN_SCRIPT: script });
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout) as unknown;
    expect(isSummary(summary) && summary.reasons).toEqual(["TOKEN_UNAVAILABLE"]);
    expect(result.stdout + result.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("refuses a token response that is not the protocol shape, without printing the token", async () => {
    // A plain WebSocket URL is not the pinned demo endpoint: the protocol refuses it, and the token is not shown.
    const body = JSON.stringify({
      token: TOKEN_SENTINEL,
      expiresAt: "2026-11-02T10:01:00.000Z",
      sessionExpiresAt: "2026-11-02T11:00:00.000Z",
      url: "ws://example.invalid/live",
    });
    const script = await stub("bad-url.sh", `printf '%s' '${body}'`);
    const result = runProbe(probeArgs, { WS_PROBE_TOKEN_SCRIPT: script });
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout) as unknown;
    expect(isSummary(summary) && summary.reasons).toEqual(["TOKEN_RESPONSE_INVALID"]);
    expect(result.stdout + result.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("refuses output that is not JSON, without printing it", async () => {
    const script = await stub("text.sh", `echo "token=${TOKEN_SENTINEL}"`);
    const result = runProbe(probeArgs, { WS_PROBE_TOKEN_SCRIPT: script });
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout) as unknown;
    expect(isSummary(summary) && summary.reasons).toEqual(["TOKEN_RESPONSE_INVALID"]);
    expect(result.stdout + result.stderr).not.toContain(TOKEN_SENTINEL);
  });
});
