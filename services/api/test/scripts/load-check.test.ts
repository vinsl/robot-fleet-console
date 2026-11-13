/**
 * Tests of the load check `scripts/load-check.sh`, run as an operator runs it: a real bash process, with stub
 * `aws` and `make` first on the PATH. The stub `aws` answers only the read-only calls the script may make and
 * records each one, so the tests check that no call changes the account, and that a refusal happens before the
 * simulator starts. The stub `make` records the simulator call and sleeps for a set time.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Root of the repository, where the script lives. */
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
/** The script under test. */
const script = path.join(repoRoot, "scripts", "load-check.sh");
/** The account the stubs answer with by default: a stand-in, never a real account. */
const EXPECTED_ACCOUNT = "123456789012";
const WS_API_ID = "abc123xyz0";
const SUB = "11111111-aaaa-4bbb-8ccc-000000000001";

/**
 * The stub `aws`. It records every call. It answers the calls the script may make: the account, the consumer
 * state, and CloudWatch statistics, from the STUB_* variables. Any other call fails, so a mutating call is a
 * test failure.
 */
const AWS_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$1 $2" in
  "sts get-caller-identity") printf '%s\\n' "\${STUB_ACCOUNT:?}" ;;
  "lambda list-event-source-mappings") printf 'uuid-0001\\n' ;;
  "lambda get-event-source-mapping") printf '%s\\n' "\${STUB_CONSUMER:?}" ;;
  "cloudwatch get-metric-statistics")
    metric=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--metric-name" ]; then metric="$arg"; fi
      prev="$arg"
    done
    case "$metric" in
      FanOutSent) value="\${STUB_SENT:-100}" ;;
      FanOutFailed) value="\${STUB_FAILED:-0}" ;;
      Throttles) value="\${STUB_THROTTLES:-0}" ;;
      *) value=0 ;;
    esac
    if [ "$value" = "0" ]; then
      printf '{"Datapoints":[]}\\n'
    else
      printf '{"Datapoints":[{"Sum":%s,"Maximum":%s}]}\\n' "$value" "$value"
    fi
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 3 ;;
esac
`;

/**
 * The stub `make`. It records the simulator call with the environment it was given, then sleeps for
 * STUB_SIM_SLEEP seconds and exits with STUB_SIM_RC.
 */
const MAKE_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'SIM_FAULT_RATE=%s SIM_MAX_RUNTIME_S=%s %s\\n' "\${SIM_FAULT_RATE:-}" "\${SIM_MAX_RUNTIME_S:-}" "$*" >>"$STUB_LOG"
sleep "\${STUB_SIM_SLEEP:-0}"
exit "\${STUB_SIM_RC:-0}"
`;

/** The read-only calls the script may make. Anything else in the stub log fails the read-only test. */
const READ_ONLY_CALLS = [
  /^sts get-caller-identity(\s|$)/,
  /^lambda list-event-source-mappings /,
  /^lambda get-event-source-mapping /,
  /^cloudwatch get-metric-statistics /,
];

/** Outcome of one run of the script. */
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-test directories and the stub log. */
interface Sandbox {
  readonly root: string;
  readonly bin: string;
  readonly state: string;
  readonly log: string;
  readonly tokenScript: string;
}

/**
 * Creates the sandbox of one test: a bin folder with the stubs, a state folder, a log and a token stub that
 * fails, so that a run never reaches the cloud.
 * @returns The sandbox paths.
 */
async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "load-check-test-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await mkdir(bin);
  await mkdir(state);
  const log = path.join(root, "calls.log");
  await writeFile(log, "");
  for (const [name, body] of [
    ["aws", AWS_STUB],
    ["make", MAKE_STUB],
  ] as const) {
    await writeFile(path.join(bin, name), body);
    await chmod(path.join(bin, name), 0o700);
  }
  const tokenScript = path.join(root, "token.sh");
  await writeFile(tokenScript, "#!/usr/bin/env bash\nexit 1\n");
  await chmod(tokenScript, 0o700);
  return { root, bin, state, log, tokenScript };
}

/**
 * Runs the script with the stubs first on the PATH.
 * @param sandbox The sandbox of the test.
 * @param args Command-line arguments of the script.
 * @param env Variables that change the stubs or the run.
 * @returns The status and the captured output.
 */
function runScript(
  sandbox: Sandbox,
  args: readonly string[],
  env: Record<string, string> = {},
): RunResult {
  const result = spawnSync("bash", [script, ...args], {
    env: {
      PATH: `${sandbox.bin}:${process.env.PATH ?? ""}`,
      HOME: sandbox.root,
      XDG_STATE_HOME: sandbox.state,
      MFC_EXPECTED_ACCOUNT_ID: EXPECTED_ACCOUNT,
      STUB_ACCOUNT: EXPECTED_ACCOUNT,
      STUB_CONSUMER: "Enabled",
      STUB_LOG: sandbox.log,
      LOAD_CHECK_SETTLE_S: "0",
      WS_PROBE_TOKEN_SCRIPT: sandbox.tokenScript,
      ...env,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Reads the calls the stub recorded.
 * @param sandbox The sandbox of the test.
 * @returns One line per recorded call.
 */
async function calls(sandbox: Sandbox): Promise<string[]> {
  const text = await readFile(sandbox.log, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

const REPORT_ARGS = [
  "report",
  "--start",
  "2026-11-02T10:00:00Z",
  "--end",
  "2026-11-02T10:10:00Z",
  "--ws-api-id",
  WS_API_ID,
];

describe("load-check usage", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.root, { recursive: true, force: true });
  });

  it("refuses a command that is not run or report", () => {
    const result = runScript(sandbox, []);
    expect(result.status).toBe(2);
  });

  it("refuses to run without the expected account in the environment", () => {
    const result = spawnSync("bash", [script, ...REPORT_ARGS], {
      env: {
        PATH: `${sandbox.bin}:${process.env.PATH ?? ""}`,
        HOME: sandbox.root,
        STUB_LOG: sandbox.log,
        LOAD_CHECK_SETTLE_S: "0",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("MFC_EXPECTED_ACCOUNT_ID");
  });

  const usageCases: [string, string[]][] = [
    [
      "more robots than the simulator takes",
      [
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
        "--robots",
        "21",
      ],
    ],
    [
      "a zero robot count",
      [
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
        "--robots",
        "0",
      ],
    ],
    [
      "a run shorter than the warm-up and the measure",
      [
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
        "--seconds",
        "60",
      ],
    ],
    [
      "a role outside the protocol",
      ["--site-id", "paris-01", "--sub", SUB, "--role", "Boss", "--ws-api-id", WS_API_ID],
    ],
  ];

  it.each(usageCases)("refuses %s with status 2 before any call", async (_label, args) => {
    const result = runScript(sandbox, ["run", ...args]);
    expect(result.status).toBe(2);
    expect(await calls(sandbox)).toEqual([]);
  });

  it("refuses a window longer than six hours", () => {
    const result = runScript(sandbox, [
      "report",
      "--start",
      "2026-11-02T00:00:00Z",
      "--end",
      "2026-11-02T07:00:00Z",
      "--ws-api-id",
      WS_API_ID,
    ]);
    expect(result.status).toBe(2);
  });

  it("refuses an end that is not after the start", () => {
    const result = runScript(sandbox, [
      "report",
      "--start",
      "2026-11-02T10:10:00Z",
      "--end",
      "2026-11-02T10:00:00Z",
      "--ws-api-id",
      WS_API_ID,
    ]);
    expect(result.status).toBe(2);
  });
});

describe("load-check refusals", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.root, { recursive: true, force: true });
  });

  it("refuses a session in another account, without naming either account, before the simulator starts", async () => {
    const result = runScript(
      sandbox,
      [
        "run",
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
      ],
      { STUB_ACCOUNT: "999999999999" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected AWS account");
    expect(result.stdout + result.stderr).not.toContain("999999999999");
    expect(
      (await calls(sandbox)).some((line) => line.startsWith("make") || line.includes("N=20")),
    ).toBe(false);
  });

  it("refuses when the ingest consumer is disabled, before the simulator starts", async () => {
    const result = runScript(
      sandbox,
      [
        "run",
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
      ],
      { STUB_CONSUMER: "Disabled" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Disabled");
    expect((await calls(sandbox)).some((line) => line.includes("sim"))).toBe(false);
  });
});

describe("load-check report", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.root, { recursive: true, force: true });
  });

  it("passes a quiet window, prints the table and writes a private summary", async () => {
    const result = runScript(sandbox, REPORT_ARGS);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ingest-telemetry throttles");
    expect(result.stdout).toContain("fan-out failed share (%)");
    expect(result.stdout).not.toContain("FAIL");
    expect(result.stdout).toContain("not measured");

    const fleet = path.join(sandbox.state, "fleet", "load-check");
    const files = await readdir(fleet);
    expect(files).toEqual(["20261102T101000Z.txt"]);
    const mode = (await stat(path.join(fleet, "20261102T101000Z.txt"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("fails the window when the ingest function throttles", () => {
    const result = runScript(sandbox, REPORT_ARGS, { STUB_THROTTLES: "3" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ingest-telemetry throttles\s+3\s+0\s+FAIL/);
  });

  it("fails a window with no fan-out, because it measured nothing", () => {
    const result = runScript(sandbox, REPORT_ARGS, { STUB_SENT: "0", STUB_FAILED: "0" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/fan-out failed share\s+no fan-out in window\s+< 1 %\s+FAIL/);
  });

  it("uses only read-only AWS calls", async () => {
    runScript(sandbox, REPORT_ARGS);
    const recorded = await calls(sandbox);
    expect(recorded.length).toBeGreaterThan(0);
    for (const line of recorded) {
      expect(READ_ONLY_CALLS.some((pattern) => pattern.test(line))).toBe(true);
    }
  });
});

describe("load-check run", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.root, { recursive: true, force: true });
  });

  it("stops at start when the simulator exits at once", () => {
    const result = runScript(
      sandbox,
      [
        "run",
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
      ],
      { STUB_SIM_RC: "3" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stopped at start");
  }, 60_000);

  it("starts the simulator with the load-check settings, runs the probe and reports its failure", async () => {
    const result = runScript(
      sandbox,
      [
        "run",
        "--site-id",
        "paris-01",
        "--sub",
        SUB,
        "--role",
        "Operator",
        "--ws-api-id",
        WS_API_ID,
        "--seconds",
        "120",
      ],
      { STUB_SIM_SLEEP: "8" },
    );
    // The token stub fails, so the probe reports a failed run: the table must say so, and the run must fail.
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/probe verdict\s+FAIL\s+PASS\s+FAIL/);
    expect(result.stdout).toMatch(/telemetry to screen p95 \(ms\)\s+no sample\s+< 1000 ms\s+FAIL/);

    const recorded = await calls(sandbox);
    const simCall = recorded.find((line) => line.includes("sim N=20"));
    expect(simCall).toBeDefined();
    expect(simCall).toContain("SIM_FAULT_RATE=6");
    expect(simCall).toContain("SIM_MAX_RUNTIME_S=300");
    for (const line of recorded.filter((call) => !call.includes("sim N="))) {
      expect({ line, ok: READ_ONLY_CALLS.some((pattern) => pattern.test(line)) }).toEqual({
        line,
        ok: true,
      });
    }
  }, 120_000);
});
