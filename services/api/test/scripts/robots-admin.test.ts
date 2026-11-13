/**
 * Tests of the operator script `scripts/robots-admin.sh`, run as an operator runs it: a real bash process,
 * with a stub `aws` first on the PATH. The stub answers the one call the script makes from a fixture,
 * records each call, and copies the invocation payload, so the tests check the script's own behaviour:
 * usage errors, refusals, the private kit file, the kit that is never printed, and one attempt per call.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Root of the repository, where the script lives. */
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
/** The script under test. */
const script = path.join(repoRoot, "scripts", "robots-admin.sh");

/**
 * Stand-in for the private key of a kit. It is not a PEM header, so no key scanner reads this file as a key,
 * and a leak of it is still detected by the assertions of this file.
 */
const KIT_SENTINEL = "FAKE-KIT-SENTINEL-DO-NOT-PRINT";

/** Successful registration answer of the function, with a kit. */
const REGISTER_ANSWER = {
  ok: true,
  status: 201,
  body: {
    robot: {
      robotId: "probe-01",
      siteId: "paris-01",
      name: "Probe 01",
      type: "PROBE",
      designDate: "2026-11-02",
      simulated: true,
      status: "ACTIVE",
      createdAt: "2026-11-02T10:00:00.000Z",
    },
    kit: {
      certificatePem: "FAKE-CERTIFICATE",
      privateKeyPem: KIT_SENTINEL,
      rootCaPem: "FAKE-ROOT-CA",
      config: {},
    },
  },
};

/** Refused answer of the function: a problem, with no kit. */
const REFUSED_ANSWER = {
  ok: false,
  status: 409,
  problem: {
    type: "urn:mfc:problem:robot-exists",
    title: "Robot exists",
    status: 409,
    correlationId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  },
};

/** Successful retirement answer of the function. */
const RETIRE_ANSWER = {
  ok: true,
  status: 200,
  body: {
    robot: {
      robotId: "probe-01",
      siteId: "paris-01",
      name: "Probe 01",
      type: "PROBE",
      designDate: "2026-11-02",
      simulated: true,
      status: "RETIRED",
      createdAt: "2026-11-02T10:00:00.000Z",
      retiredAt: "2026-11-02T11:00:00.000Z",
    },
    alreadyRetired: false,
  },
};

/**
 * The stub of the AWS CLI. It accepts only the `lambda invoke` call of the script, and answers according to
 * STUB_MODE: `answer` copies STUB_ANSWER into the response file, `function-error` reports an unhandled error,
 * `transport-error` fails as a connection would without writing the response, and `partial-error` writes
 * STUB_ANSWER into the response file and then fails, as a connection lost after the answer would.
 */
const AWS_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'AWS_MAX_ATTEMPTS=%s %s\\n' "\${AWS_MAX_ATTEMPTS:-unset}" "$*" >>"$STUB_LOG"
if [ "$1 $2" != "lambda invoke" ]; then
  echo "unexpected aws call: $*" >&2
  exit 3
fi
args=("$@")
out="\${args[-1]}"
payload="\${args[-2]#fileb://}"
cp "$payload" "$STUB_LOG.payload.json"
case "\${STUB_MODE:?}" in
  answer) cp "$STUB_ANSWER" "$out"; printf '{"StatusCode":200}\\n' ;;
  function-error) printf '{"StatusCode":200,"FunctionError":"Unhandled"}\\n' ;;
  transport-error) echo "could not connect to the endpoint" >&2; exit 255 ;;
  partial-error) cp "$STUB_ANSWER" "$out"; echo "connection lost" >&2; exit 255 ;;
  *) echo "bad stub mode" >&2; exit 2 ;;
esac
`;

/** Outcome of one run of the script. */
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-test directories: a home for the kit tree, a bin with the stub, and the stub's log and answer. */
interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly log: string;
  readonly answer: string;
}

let sandbox: Sandbox;

/**
 * Creates the sandbox of one test: a fresh home, the stub `aws` in its own bin directory, and no answer yet.
 *
 * @returns The sandbox paths.
 */
async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "robots-admin-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  const stub = path.join(bin, "aws");
  await writeFile(stub, AWS_STUB);
  await chmod(stub, 0o755);
  return { root, home, log: path.join(root, "aws.log"), answer: path.join(root, "answer.json") };
}

/**
 * Runs the script with the stub, the sandbox home and the given answer of the stub.
 *
 * @param args - The arguments of the script.
 * @param mode - The stub behaviour.
 * @param answer - The JSON answer the stub copies, for the `answer` mode.
 * @returns The exit status and the output of the script.
 */
async function runScript(
  args: readonly string[],
  mode: "answer" | "function-error" | "transport-error" | "partial-error",
  answer?: unknown,
): Promise<RunResult> {
  if (answer !== undefined) {
    await writeFile(sandbox.answer, JSON.stringify(answer));
  }
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${path.join(sandbox.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: sandbox.home,
      STUB_LOG: sandbox.log,
      STUB_MODE: mode,
      STUB_ANSWER: sandbox.answer,
    },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * @param file - A file or directory.
 * @returns Its permission bits, in octal notation as a number.
 */
function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

/** The kit file of the probe robot, as the script writes it. */
function kitFile(): string {
  return path.join(sandbox.home, ".fleet", "robots", "probe-01", "register-response.json");
}

/** Arguments of a valid registration of the probe robot. */
const REGISTER_ARGS = [
  "register",
  "--robot-id",
  "probe-01",
  "--site-id",
  "paris-01",
  "--name",
  "Probe 01",
  "--type",
  "PROBE",
  "--design-date",
  "2026-11-02",
  "--simulated",
  "true",
  "--actor",
  "vincent",
];

/** Arguments of a valid retirement of the probe robot. */
const RETIRE_ARGS = [
  "retire",
  "--robot-id",
  "probe-01",
  "--site-id",
  "paris-01",
  "--actor",
  "vincent",
];

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

describe("robots-admin.sh: usage and validation", () => {
  it.each([
    ["no arguments", [], "Usage:"],
    ["an unknown command", ["bogus"], "unknown command: bogus"],
    [
      "an invalid robot id",
      [...REGISTER_ARGS.slice(0, 2), "Probe_01", ...REGISTER_ARGS.slice(3)],
      "--robot-id must match",
    ],
    [
      "a simulated flag that is not boolean",
      REGISTER_ARGS.map((arg) => (arg === "true" ? "yes" : arg)),
      "--simulated must be true or false",
    ],
    [
      "a design date that is not ISO",
      REGISTER_ARGS.map((arg) => (arg === "2026-11-02" ? "02-11-2026" : arg)),
      "--design-date must be YYYY-MM-DD",
    ],
    [
      "an actor with a space",
      REGISTER_ARGS.map((arg) => (arg === "vincent" ? "a b" : arg)),
      "--actor must match",
    ],
    [
      "an option that the command does not take",
      [...RETIRE_ARGS, "--simulated", "true"],
      "option --simulated is not valid for retire",
    ],
    [
      "an option given twice",
      [...REGISTER_ARGS, "--robot-id", "probe-02"],
      "option --robot-id is given twice",
    ],
    ["a missing option", RETIRE_ARGS.slice(0, -2), "missing --actor"],
    ["an option without a value", [...RETIRE_ARGS, "--actor"], "option --actor needs a value"],
    ["a positional argument", ["retire", "probe-01"], "unexpected argument: probe-01"],
  ])("refuses %s with status 2, before any AWS call or trace", async (_label, args, message) => {
    const result = await runScript(args, "answer", REGISTER_ANSWER);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    expect(existsSync(sandbox.log)).toBe(false);
    expect(existsSync(path.join(sandbox.home, ".fleet"))).toBe(false);
  });

  it("accepts the help command with status 0 and prints the usage only", async () => {
    const result = await runScript(["--help"], "answer", REGISTER_ANSWER);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Usage:");
    expect(existsSync(sandbox.log)).toBe(false);
  });
});

describe("robots-admin.sh: register", () => {
  it("creates the kit file private and prints the summary only", async () => {
    const result = await runScript(REGISTER_ARGS, "answer", REGISTER_ANSWER);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 201,
      robot: { robotId: "probe-01", status: "ACTIVE" },
    });
    expect(modeOf(path.join(sandbox.home, ".fleet"))).toBe(0o700);
    expect(modeOf(path.join(sandbox.home, ".fleet", "robots"))).toBe(0o700);
    expect(modeOf(path.join(sandbox.home, ".fleet", "robots", "probe-01"))).toBe(0o700);
    expect(modeOf(kitFile())).toBe(0o600);
    expect(await readFile(kitFile(), "utf8")).toContain(KIT_SENTINEL);
  });

  it("never prints the kit on stdout or stderr", async () => {
    const result = await runScript(REGISTER_ARGS, "answer", REGISTER_ANSWER);

    expect(result.stdout).not.toContain(KIT_SENTINEL);
    expect(result.stderr).not.toContain(KIT_SENTINEL);
  });

  it("sends the registration event once, with one attempt and the 90 s read timeout", async () => {
    await runScript(REGISTER_ARGS, "answer", REGISTER_ANSWER);

    const calls = (await readFile(sandbox.log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("AWS_MAX_ATTEMPTS=1 lambda invoke");
    expect(calls[0]).toContain("--cli-read-timeout 90");
    expect(calls[0]).toContain("--function-name mfc-demo-robots");

    const payload: unknown = JSON.parse(await readFile(`${sandbox.log}.payload.json`, "utf8"));
    expect(payload).toStrictEqual({
      source: "mfc.admin",
      action: "robots.register",
      actor: "vincent",
      body: {
        robotId: "probe-01",
        siteId: "paris-01",
        name: "Probe 01",
        type: "PROBE",
        designDate: "2026-11-02",
        simulated: true,
      },
    });
  });

  it("refuses to overwrite an existing kit, and makes no call", async () => {
    await mkdir(path.dirname(kitFile()), { recursive: true, mode: 0o700 });
    await writeFile(kitFile(), "previous kit", { mode: 0o600 });

    const result = await runScript(REGISTER_ARGS, "answer", REGISTER_ANSWER);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(await readFile(kitFile(), "utf8")).toBe("previous kit");
    expect(existsSync(sandbox.log)).toBe(false);
  });

  it("refuses with status 1, prints the problem only, and keeps no answer file", async () => {
    const result = await runScript(REGISTER_ARGS, "answer", REFUSED_ANSWER);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 409,
      problem: { type: "urn:mfc:problem:robot-exists" },
    });
    expect(existsSync(kitFile())).toBe(false);
  });

  it("fails with status 1 when the function raises an unhandled error, and keeps no answer file", async () => {
    const result = await runScript(REGISTER_ARGS, "function-error");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the function raised an unhandled error");
    expect(existsSync(kitFile())).toBe(false);
  });

  it("fails with status 1 and the SSO hint when the invocation does not complete", async () => {
    const result = await runScript(REGISTER_ARGS, "transport-error");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aws sso login");
    expect(result.stdout).toBe("");
  });

  it("removes the empty placeholder when the invocation does not complete", async () => {
    const result = await runScript(REGISTER_ARGS, "transport-error");

    expect(result.status).toBe(1);
    expect(existsSync(kitFile())).toBe(false);
  });

  it("keeps a non-empty answer when the invocation fails after it was written, and prints no kit", async () => {
    const result = await runScript(REGISTER_ARGS, "partial-error", REGISTER_ANSWER);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aws sso login");
    expect(await readFile(kitFile(), "utf8")).toContain(KIT_SENTINEL);
    expect(result.stdout).not.toContain(KIT_SENTINEL);
    expect(result.stderr).not.toContain(KIT_SENTINEL);
  });

  it("refuses an answer that is not the result of this command", async () => {
    const result = await runScript(REGISTER_ARGS, "answer", { ok: true, status: 201, body: {} });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a result of this command");
    expect(existsSync(kitFile())).toBe(false);
  });
});

describe("robots-admin.sh: retire", () => {
  it("prints the retirement summary and creates no kit directory", async () => {
    const result = await runScript(RETIRE_ARGS, "answer", RETIRE_ANSWER);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 200,
      robot: { robotId: "probe-01", status: "RETIRED" },
    });
    expect(existsSync(path.join(sandbox.home, ".fleet"))).toBe(false);
  });

  it("sends the retirement event", async () => {
    await runScript(RETIRE_ARGS, "answer", RETIRE_ANSWER);

    const payload: unknown = JSON.parse(await readFile(`${sandbox.log}.payload.json`, "utf8"));
    expect(payload).toStrictEqual({
      source: "mfc.admin",
      action: "robots.retire",
      actor: "vincent",
      body: { robotId: "probe-01", siteId: "paris-01" },
    });
  });

  it("refuses with status 1 and prints the problem only", async () => {
    const result = await runScript(RETIRE_ARGS, "answer", REFUSED_ANSWER);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 409 });
  });
});
