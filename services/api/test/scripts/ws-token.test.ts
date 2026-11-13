/**
 * Tests of the operator script `scripts/ws-token.sh`, run as an operator runs it: a real bash process with a stub
 * `aws` first on the PATH. The stub records its call and copies the payload, and answers from a fixture. The tests
 * check the request the script builds, the single attempt, the printed token, and that nothing is left on disk.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Root of the repository, where the script lives. */
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
/** The script under test. */
const script = path.join(repoRoot, "scripts", "ws-token.sh");

/** The token of the fixture answer. It is not a real token: it only has the right shape. */
const TOKEN_SENTINEL = "TOKEN-SENTINEL-" + "A".repeat(29);

/** A successful answer of the function. */
const ISSUED_ANSWER = {
  statusCode: 200,
  body: {
    token: TOKEN_SENTINEL,
    expiresAt: "2026-11-02T10:01:00.000Z",
    sessionExpiresAt: "2026-11-02T10:55:00.000Z",
    url: "wss://abc123.execute-api.eu-west-3.amazonaws.com/live",
  },
};

/** A refused answer of the function: a problem, with no token. */
const REFUSED_ANSWER = {
  statusCode: 403,
  body: {
    type: "urn:mfc:problem:forbidden-site",
    title: "Site not allowed",
    status: 403,
    detail: "The principal has no access to this site.",
    correlationId: "ws-token-0123456789abcdef",
  },
};

/** The stub of the AWS CLI: it accepts only `lambda invoke`, answers from STUB_MODE, and records the call. */
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
  *) echo "bad stub mode" >&2; exit 2 ;;
esac
`;

/** Per-test directories: a bin with the stub, a scratch directory the script must empty, and the stub's files. */
interface Sandbox {
  readonly root: string;
  readonly scratch: string;
  readonly log: string;
  readonly answer: string;
}

/** The sandbox of the current test. */
let sandbox: Sandbox;

/**
 * Creates the sandbox of one test.
 *
 * @returns The sandbox paths.
 */
async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ws-token-"));
  const bin = path.join(root, "bin");
  const scratch = path.join(root, "scratch");
  await mkdir(bin, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const stub = path.join(bin, "aws");
  await writeFile(stub, AWS_STUB);
  await chmod(stub, 0o755);
  return { root, scratch, log: path.join(root, "aws.log"), answer: path.join(root, "answer.json") };
}

/** Outcome of one run of the script. */
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the script with the stub, in the sandbox.
 *
 * @param args - The arguments of the script.
 * @param mode - The stub behaviour.
 * @param answer - The JSON answer the stub copies, for the `answer` mode.
 * @returns The exit status and the output.
 */
async function runScript(
  args: readonly string[],
  mode: "answer" | "function-error" | "transport-error",
  answer?: unknown,
): Promise<RunResult> {
  if (answer !== undefined) {
    await writeFile(sandbox.answer, JSON.stringify(answer));
  }
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${path.join(sandbox.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: sandbox.root,
      TMPDIR: sandbox.scratch,
      STUB_LOG: sandbox.log,
      STUB_MODE: mode,
      STUB_ANSWER: sandbox.answer,
    },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Arguments of a valid request. */
const VALID_ARGS = [
  "--site-id",
  "paris-01",
  "--sub",
  "00000000-0000-4000-8000-000000000001",
  "--role",
  "Operator",
];

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

describe("ws-token.sh usage", () => {
  it("prints the usage and exits 2 with no argument", async () => {
    const result = await runScript([], "answer", ISSUED_ANSWER);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it.each([
    ["an unknown option", [...VALID_ARGS, "--sid", "x"]],
    ["a role outside the list", ["--site-id", "paris-01", "--sub", "u1", "--role", "Root"]],
    ["an invalid site", ["--site-id", "Paris", "--sub", "u1", "--role", "Viewer"]],
    ["a missing subject", ["--site-id", "paris-01", "--role", "Viewer"]],
    ["a repeated option", [...VALID_ARGS, "--role", "Viewer"]],
  ])("refuses %s with exit 2 before any AWS call", async (_label, args) => {
    const result = await runScript(args, "answer", ISSUED_ANSWER);
    expect(result.status).toBe(2);
    await expect(readFile(sandbox.log, "utf8")).rejects.toThrow();
  });
});

describe("ws-token.sh request", () => {
  it("invokes the function once, with the principal of the site and a session of 55 minutes", async () => {
    await runScript(VALID_ARGS, "answer", ISSUED_ANSWER);

    const log = await readFile(sandbox.log, "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain("AWS_MAX_ATTEMPTS=1 lambda invoke --function-name mfc-demo-ws-token");

    const payload = JSON.parse(await readFile(`${sandbox.log}.payload.json`, "utf8")) as {
      principal: { sub: string; role: string; siteIds: string[]; sessionExpiresAt: string };
      request: { siteId: string };
      correlationId: string;
    };
    expect(payload.principal).toMatchObject({
      sub: "00000000-0000-4000-8000-000000000001",
      role: "Operator",
      siteIds: ["paris-01"],
    });
    expect(payload.request).toStrictEqual({ siteId: "paris-01" });
    expect(payload.correlationId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    const sessionMs = Date.parse(payload.principal.sessionExpiresAt) - Date.now();
    expect(sessionMs).toBeGreaterThan(54 * 60 * 1000);
    expect(sessionMs).toBeLessThanOrEqual(55 * 60 * 1000);
  });
});

describe("ws-token.sh answers", () => {
  it("prints the URL and the token on stdout, and nothing on stderr", async () => {
    const result = await runScript(VALID_ARGS, "answer", ISSUED_ANSWER);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`url: ${ISSUED_ANSWER.body.url}\ntoken: ${TOKEN_SENTINEL}\n`);
    expect(result.stderr).toBe("");
  });

  it("reports a refusal with its status and problem type, and prints no token", async () => {
    const result = await runScript(VALID_ARGS, "answer", REFUSED_ANSWER);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("refused: status 403, Site not allowed");
    expect(result.stderr).not.toContain(TOKEN_SENTINEL);
  });

  it("fails when the function raises an unhandled error", async () => {
    const result = await runScript(VALID_ARGS, "function-error");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unhandled error");
  });

  it("fails without retrying when the invocation cannot complete", async () => {
    const result = await runScript(VALID_ARGS, "transport-error");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect((await readFile(sandbox.log, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("leaves no file of the run behind", async () => {
    await runScript(VALID_ARGS, "answer", ISSUED_ANSWER);
    expect(await readdir(sandbox.scratch)).toStrictEqual([]);
  });
});
