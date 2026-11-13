/* eslint-disable security/detect-non-literal-fs-filename -- every path is built under a fresh temporary directory of this test */
/**
 * Tests of the e2e setup and teardown scripts, run with fake `aws`, `curl` and `uv` binaries on PATH. No AWS call is
 * made: the fakes append their argument lists to a log and answer from fixture files. The production robots-admin.sh
 * runs unchanged on top of the fake `aws`. The fake `uv` is written per test with its settings embedded, because the
 * simulator runs with an allowlisted environment and cannot read the test's variables. Run by `make check-ts` with
 * `node --test`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETUP = join(ROOT, "scripts", "e2e-setup.sh");
const TEARDOWN = join(ROOT, "scripts", "e2e-teardown.sh");
const CONSOLE_URL = "https://console.example.com";
const REGION = "eu-west-3";
const POOL = "eu-west-3_AbCdEf123";
/** The only environment variables the simulator may receive (scripts/e2e-setup.sh start_simulator). */
const SIM_ENV_ALLOWLIST = ["HOME", "LANG", "PATH", "TMPDIR"];
/** The event source mapping of the telemetry consumer, as the fake lists it. */
const CONSUMER_UUID = "3f2a9c1e-0000-4000-8000-000000000042";

/** Fake `aws`: logs its argument list, never a file body, and answers the operations the scripts call. */
const FAKE_AWS = `#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.FAKE_LOG, "aws " + args.join(" ") + "\\n");
const fixture = (name) => readFileSync(join(env.FAKE_DIR, name), "utf8");
const fail = (code, operation) => {
  process.stderr.write("An error occurred (" + code + ") when calling the " + operation + " operation: refused\\n");
  process.exit(255);
};
const key = args[0] + " " + args[1];
if (key === "cognito-idp list-users") {
  process.stdout.write(fixture("list-users.json"));
} else if (key === "cognito-idp admin-create-user") {
  copyFileSync(args[args.indexOf("--cli-input-json") + 1].replace(/^file:\\/\\//, ""), join(env.FAKE_DIR, "created.json"));
  if (env.FAKE_CREATE_FAIL === "1") fail("InvalidParameterException", "AdminCreateUser");
} else if (key === "cognito-idp admin-add-user-to-group") {
  if (env.FAKE_GROUP_FAIL === "1") fail("ResourceNotFoundException", "AdminAddUserToGroup");
} else if (key === "cognito-idp admin-delete-user") {
  if (env.FAKE_DELETE_ERROR) fail(env.FAKE_DELETE_ERROR, "AdminDeleteUser");
} else if (key === "lambda invoke") {
  const payload = args[args.indexOf("--payload") + 1].replace(/^fileb:\\/\\//, "");
  const isRegister = readFileSync(payload, "utf8").includes("robots.register");
  writeFileSync(args[args.length - 1], fixture(isRegister ? env.FAKE_REGISTER : env.FAKE_RETIRE));
  process.stdout.write('{"StatusCode":200}\\n');
} else if (key === "sts get-caller-identity") {
  process.stdout.write("{}\\n");
} else if (key === "lambda list-event-source-mappings") {
  process.stdout.write("${CONSUMER_UUID}\\n");
} else if (key === "lambda get-event-source-mapping") {
  process.stdout.write(readFileSync(join(env.FAKE_DIR, "consumer-state"), "utf8"));
} else if (key === "lambda update-event-source-mapping") {
  if (env.FAKE_CONSUMER_UPDATE_FAIL === "1") fail("ResourceConflictException", "UpdateEventSourceMapping");
  writeFileSync(join(env.FAKE_DIR, "consumer-state"), args.includes("--no-enabled") ? "Disabled\\n" : "Enabled\\n");
} else {
  process.stderr.write("unexpected aws call\\n");
  process.exit(3);
}
`;

/** Fake `curl`: serves the public runtime configuration fixture. */
const FAKE_CURL = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const env = process.env;
appendFileSync(env.FAKE_LOG, "curl " + process.argv.slice(2).join(" ") + "\\n");
if (env.FAKE_CONFIG_FAIL === "1") process.exit(22);
process.stdout.write(readFileSync(join(env.FAKE_DIR, "config.json"), "utf8"));
`;

/**
 * Fake `uv`, the simulator. It logs its arguments, the NAMES of the environment variables it received (never their
 * values) and whether an AWS key reached it. It then announces the connection like the agent does, or stays silent,
 * and runs until it is stopped.
 *
 * @param {string} log - Path of the call log.
 * @param {number} exitCode - When not 0, the fake exits at once with this code.
 * @param {boolean} connect - Whether it prints the connection line the setup waits for.
 * @returns {string} The script source.
 */
function fakeUvSource(log, exitCode, connect) {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const keys = Object.keys(process.env).sort().join(",");
const aws = process.env.AWS_ACCESS_KEY_ID === undefined ? "absent" : "present";
appendFileSync(${JSON.stringify(log)}, "uv " + process.argv.slice(2).join(" ") + " env-keys=" + keys + " aws-env=" + aws + "\\n");
if (${String(exitCode)} !== 0) process.exit(${String(exitCode)});
if (${String(connect)}) process.stdout.write("link.connected\\n");
setInterval(() => {}, 1000);
`;
}

const CONFIG_OK = {
  apiUrl: "https://abc123.execute-api.eu-west-3.amazonaws.com",
  identityPoolId: "eu-west-3:11111111-2222-3333-4444-555555555555",
  region: REGION,
  userPoolClientId: "abcdefghijklmnopqrstuvwxyz",
  userPoolId: POOL,
  wsUrl: "wss://abc123.execute-api.eu-west-3.amazonaws.com/ws",
};

const ROBOT_OK = {
  robotId: "e2e1234567a2-01",
  siteId: "paris-01",
  name: "E2E 1234567a2",
  type: "SIM",
  designDate: "2026-11-04",
  simulated: true,
  status: "ACTIVE",
  createdAt: "2026-11-04T10:00:00.000Z",
};

/** Answers of the robots function, one fixture per outcome. */
const FIXTURES = {
  "register-ok.json": { ok: true, status: 201, body: { robot: ROBOT_OK } },
  "register-fail.json": {
    ok: false,
    status: 500,
    problem: {
      type: "urn:mfc:problem:internal",
      title: "Internal error",
      status: 500,
      detail: "Unexpected error.",
    },
  },
  "retire-ok.json": { ok: true, status: 200, body: { robot: { ...ROBOT_OK, status: "RETIRED" } } },
  "retire-not-found.json": {
    ok: false,
    status: 404,
    problem: {
      type: "urn:mfc:problem:robot-not-found",
      title: "Robot not found",
      status: 404,
      detail: "No robot with this id at this site.",
    },
  },
  "retire-internal.json": {
    ok: false,
    status: 500,
    problem: {
      type: "urn:mfc:problem:internal",
      title: "Internal error",
      status: 500,
      detail: "Unexpected error.",
    },
  },
};

/** A state file as the setup writes it after the simulator starts, with fake values. */
function stateOf(overrides = {}) {
  return {
    consoleUrl: CONSOLE_URL,
    region: REGION,
    userPoolId: POOL,
    siteId: "paris-01",
    email: "e2e-1234567-2@example.com",
    robotId: "e2e1234567a2-01",
    robotName: "E2E 1234567a2",
    temporaryPassword: "TempSecret0123456789Aa1!",
    password: "NewSecret0123456789Aa1!",
    simPid: 999999,
    simStart: 12345,
    ...overrides,
  };
}

/** Every test works in its own directory: fake binaries, fixtures, a private HOME and a private RUNNER_TEMP. */
const worlds = [];

/**
 * Creates a sandbox with the fake binaries and the fixtures, and returns the environment of the scripts.
 *
 * @param {Record<string, string>} [overrides] - Fake behaviour of aws and curl, passed as environment variables.
 * @param {{ exitCode?: number, connect?: boolean }} [uv] - Behaviour of the fake simulator.
 * @returns {{ env: Record<string, string>, stateDir: string, log: string, fixtures: string, home: string }} The sandbox.
 */
function world(overrides = {}, uv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-e2e-scripts-"));
  worlds.push(dir);
  const bin = join(dir, "bin");
  const fixtures = join(dir, "fixtures");
  const home = join(dir, "home");
  const runner = join(dir, "runner");
  for (const path of [bin, fixtures, home, runner]) {
    mkdirSync(path, { recursive: true });
  }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  for (const [name, source] of [
    ["aws", FAKE_AWS],
    ["curl", FAKE_CURL],
    ["uv", fakeUvSource(log, uv.exitCode ?? 0, uv.connect ?? true)],
  ]) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(fixtures, "config.json"), JSON.stringify(CONFIG_OK));
  writeFileSync(join(fixtures, "list-users.json"), JSON.stringify({ Users: [] }));
  // The telemetry consumer starts Disabled, as it is outside a demo, unless a test says otherwise.
  writeFileSync(
    join(fixtures, "consumer-state"),
    `${String(overrides["FAKE_CONSUMER_STATE"] ?? "Disabled")}\n`,
  );
  for (const [name, body] of Object.entries(FIXTURES)) {
    writeFileSync(join(fixtures, name), JSON.stringify(body));
  }
  // The environment of the CI job and of the developer shell must not leak into the scripts: only the listed keys are set.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AWS_") && !key.startsWith("GITHUB_"),
    ),
  );
  const env = {
    ...inherited,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    RUNNER_TEMP: runner,
    FAKE_DIR: fixtures,
    FAKE_LOG: log,
    FAKE_REGISTER: "register-ok.json",
    FAKE_RETIRE: "retire-ok.json",
    CONSOLE_URL,
    AWS_REGION: REGION,
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
    GITHUB_RUN_ID: "1234567",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_ACTIONS: "true",
    ...overrides,
  };
  return { env, stateDir: join(runner, "mfc-e2e"), log, fixtures, home };
}

/**
 * Runs a script with the sandbox environment.
 *
 * @param {string} script - Absolute path of the script.
 * @param {readonly string[]} args - Arguments.
 * @param {Record<string, string>} env - Environment.
 * @returns {{ status: number | null, stdout: string, stderr: string }} The result.
 */
function run(script, args, env) {
  const result = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Reads the calls the fakes logged, one line per call.
 *
 * @param {string} log - Path of the log.
 * @returns {string[]} The lines.
 */
function callsOf(log) {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Writes a state file with private modes, as the setup does.
 *
 * @param {string} stateDir - The state directory.
 * @param {Record<string, unknown>} state - The state content.
 */
function writeStateFile(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(state), { mode: 0o600 });
}

/**
 * Reads the state file of a sandbox.
 *
 * @param {string} stateDir - The state directory.
 * @returns {{ password: string, temporaryPassword: string, robotId: string, simPid?: number, simStart?: number, consumerWasEnabled?: boolean }} The fields the tests use.
 */
function readState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
}

/**
 * Tells whether a process has ended: no entry in /proc, or a zombie that has exited and waits to be reaped.
 *
 * @param {number} pid - The process identifier.
 * @returns {boolean} True when the process is gone.
 */
function isDead(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state === "Z";
  } catch {
    return true;
  }
}

/**
 * Stops a simulator started by a test, so that no fake process outlives the run.
 *
 * @param {string} stateDir - The state directory of the sandbox.
 */
function stopSimulatorOf(stateDir) {
  const path = join(stateDir, "state.json");
  if (!existsSync(path)) {
    return;
  }
  const pid = readState(stateDir).simPid;
  if (typeof pid === "number") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone: the simulator stopped on its own.
    }
  }
}

afterEach(() => {
  for (const dir of worlds.splice(0)) {
    const stateDir = join(dir, "runner", "mfc-e2e");
    stopSimulatorOf(stateDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("e2e-setup", () => {
  it("creates the operator and the robot, starts the simulator and writes a private state", () => {
    const sandbox = world();
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /e2e-setup: OK/);

    const calls = callsOf(sandbox.log);
    const order = [
      "cognito-idp list-users",
      "cognito-idp admin-create-user",
      "cognito-idp admin-add-user-to-group",
      "lambda invoke",
      "uv run",
    ];
    const positions = order.map((needle) => calls.findIndex((line) => line.includes(needle)));
    assert.ok(
      positions.every((position) => position >= 0),
      `missing call in ${JSON.stringify(order)}`,
    );
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
    );
    assert.ok(
      calls.some((line) => line.includes("--group-name Operator")),
      "the operator joins the Operator group",
    );

    const state = readState(sandbox.stateDir);
    assert.equal(statSync(sandbox.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(sandbox.stateDir, "state.json")).mode & 0o777, 0o600);
    assert.equal(typeof state.simPid, "number");
    assert.equal(typeof state.simStart, "number");
    assert.match(state.robotId, /^e2e1234567a2-01$/);
    assert.ok(!calls.join("\n").includes(state.password), "no call holds the password");
    assert.ok(
      !calls.join("\n").includes(state.temporaryPassword),
      "no call holds the temporary password",
    );
    assert.ok(
      result.stdout.includes(`::add-mask::${state.temporaryPassword}\n`),
      "the temporary password is masked",
    );
    assert.ok(result.stdout.includes(`::add-mask::${state.password}\n`), "the password is masked");
  });

  it("starts the simulator with an allowlisted environment and no AWS, CI or GitHub variable", () => {
    const sandbox = world();
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    const uvLine = callsOf(sandbox.log).find((line) => line.startsWith("uv run"));
    assert.ok(uvLine, "the simulator was started");
    assert.ok(uvLine.endsWith("aws-env=absent"), "the AWS key did not reach the simulator");
    const keys = /env-keys=(\S*)/.exec(uvLine)?.[1]?.split(",") ?? [];
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok(
        SIM_ENV_ALLOWLIST.includes(key),
        `unexpected variable ${key} reached the simulator`,
      );
    }
  });

  it("runs the simulator in its own session, so that teardown can stop its whole group", () => {
    const sandbox = world();
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    const state = readState(sandbox.stateDir);
    const stat = readFileSync(`/proc/${String(state.simPid)}/stat`, "utf8");
    // Field 5 is the process group, field 6 the session: both are the pid of the simulator's leader.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    assert.equal(fields[2], String(state.simPid), "process group is the simulator pid");
    assert.equal(fields[3], String(state.simPid), "session is the simulator pid");
  });

  it("exits 1 when the registration fails, leaves a phase-one state and no pid, and teardown deletes the operator", () => {
    const sandbox = world({ FAKE_REGISTER: "register-fail.json" });
    const failed = run(SETUP, [], sandbox.env);
    assert.equal(failed.status, 1);
    const phaseOne = readState(sandbox.stateDir);
    assert.equal(phaseOne.simPid, undefined);
    assert.equal(phaseOne.temporaryPassword, undefined);
    assert.equal(phaseOne.robotId, "e2e1234567a2-01");

    const teardown = run(TEARDOWN, [], { ...sandbox.env, FAKE_RETIRE: "retire-not-found.json" });
    assert.equal(teardown.status, 0, teardown.stderr);
    assert.ok(
      callsOf(sandbox.log).some((line) => line.includes("admin-delete-user")),
      "the operator is deleted",
    );
    assert.equal(existsSync(sandbox.stateDir), false);
  });

  it("exits 1 when the simulator exits before the robot connects, and keeps its pid for teardown", () => {
    const sandbox = world({}, { exitCode: 1 });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulator exited/);
    assert.equal(
      typeof readState(sandbox.stateDir).simPid,
      "number",
      "the pid is kept for teardown",
    );
  });

  it("enables a disabled telemetry consumer for the run and records that it was disabled", () => {
    const sandbox = world({ FAKE_CONSUMER_STATE: "Disabled" });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    const calls = callsOf(sandbox.log);
    const updates = calls.filter((line) => line.includes("update-event-source-mapping"));
    assert.equal(updates.length, 1, "the consumer is updated once");
    assert.ok(updates[0]?.includes("--enabled"), "the consumer is enabled");
    assert.equal(readFileSync(join(sandbox.fixtures, "consumer-state"), "utf8").trim(), "Enabled");
    assert.equal(readState(sandbox.stateDir).consumerWasEnabled, false);
  });

  it("leaves an already enabled telemetry consumer untouched and records that it was enabled", () => {
    const sandbox = world({ FAKE_CONSUMER_STATE: "Enabled" });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already enabled, left as it is/);
    assert.ok(
      !callsOf(sandbox.log).some((line) => line.includes("update-event-source-mapping")),
      "the consumer is not updated",
    );
    assert.equal(readState(sandbox.stateDir).consumerWasEnabled, true);
  });

  it("exits 1 when the telemetry consumer cannot be enabled, and records that it was disabled", () => {
    const sandbox = world({ FAKE_CONSUMER_UPDATE_FAIL: "1" });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be enabled; teardown restores it/);
    assert.equal(readState(sandbox.stateDir).consumerWasEnabled, false, "teardown can restore it");
  });

  it("stops a simulator that never connects when the setup fails", () => {
    const sandbox = world({}, { connect: false });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not connect within 30 seconds/);
    const pid = readState(sandbox.stateDir).simPid;
    assert.equal(typeof pid, "number");
    assert.equal(isDead(pid), true, "the failed run left no simulator running");
  });

  it("stops before any creation when config.json has an extra key", () => {
    const sandbox = world();
    writeFileSync(
      join(sandbox.fixtures, "config.json"),
      JSON.stringify({ ...CONFIG_OK, extra: "x" }),
    );
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.ok(!callsOf(sandbox.log).some((line) => line.includes("admin-create-user")));
    assert.equal(existsSync(sandbox.stateDir), false);
  });

  it("stops before any creation when config.json cannot be read", () => {
    const sandbox = world({ FAKE_CONFIG_FAIL: "1" });
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.ok(!callsOf(sandbox.log).some((line) => line.includes("admin-create-user")));
  });

  it("exits 2 with a clear message when CONSOLE_URL is missing", () => {
    const sandbox = world();
    const env = { ...sandbox.env };
    delete env["CONSOLE_URL"];
    const result = run(SETUP, [], env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CONSOLE_URL and AWS_REGION are required/);
  });

  it("sweeps only stale e2e users, found by their e-mail and deleted by their opaque Username", () => {
    const sandbox = world();
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const stale = "0b8f1c2e-1a2b-4c3d-9e8f-000000000001";
    writeFileSync(
      join(sandbox.fixtures, "list-users.json"),
      JSON.stringify({
        Users: [
          {
            Username: stale,
            Attributes: [
              { Name: "sub", Value: "0b8f" },
              { Name: "email", Value: "e2e-1000-1@example.com" },
            ],
            UserCreateDate: threeHoursAgo,
          },
          {
            Username: "0b8f1c2e-1a2b-4c3d-9e8f-000000000002",
            Attributes: [{ Name: "email", Value: "e2e-1001-1@example.com" }],
            UserCreateDate: tenMinutesAgo,
          },
          {
            Username: "0b8f1c2e-1a2b-4c3d-9e8f-000000000003",
            Attributes: [{ Name: "email", Value: "ceo@example.com" }],
            UserCreateDate: threeHoursAgo,
          },
          {
            Username: "0b8f1c2e-1a2b-4c3d-9e8f-000000000004",
            Attributes: [{ Name: "email", Value: "e2e-1002-1@example.com" }],
          },
          {
            Username: "not-a-uuid",
            Attributes: [{ Name: "email", Value: "e2e-1003-1@example.com" }],
            UserCreateDate: threeHoursAgo,
          },
        ],
      }),
    );
    const result = run(SETUP, [], sandbox.env);
    assert.equal(result.status, 0, result.stderr);
    const deletions = callsOf(sandbox.log).filter((line) => line.includes("admin-delete-user"));
    assert.equal(deletions.length, 1);
    assert.ok(deletions[0]?.includes(`--username ${stale}`), "the user is deleted by its Username");
    assert.ok(!deletions[0]?.includes("@example.com"), "no e-mail is passed to the deletion");
  });
});

describe("e2e-teardown", () => {
  it("deletes everything a nominal run created, and a second run finds nothing to clean", () => {
    const sandbox = world();
    const setup = run(SETUP, [], sandbox.env);
    assert.equal(setup.status, 0, setup.stderr);
    const pid = readState(sandbox.stateDir).simPid;
    assert.equal(typeof pid, "number");

    const first = run(TEARDOWN, [], sandbox.env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /the simulator stopped/);
    assert.match(first.stdout, /robot retired/);
    assert.match(first.stdout, /operator deleted/);
    assert.equal(isDead(pid), true, "the simulator is gone");
    assert.equal(existsSync(sandbox.stateDir), false);

    const second = run(TEARDOWN, [], sandbox.env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /nothing to clean/);
  });

  it("deletes the operator and exits 1 when the retirement fails, and keeps the state for a retry", () => {
    const sandbox = world();
    writeStateFile(sandbox.stateDir, stateOf({ simPid: undefined, simStart: undefined }));
    const result = run(TEARDOWN, [], { ...sandbox.env, FAKE_RETIRE: "retire-internal.json" });
    assert.equal(result.status, 1);
    assert.ok(
      callsOf(sandbox.log).some((line) => line.includes("admin-delete-user")),
      "the operator is still deleted",
    );
    assert.equal(existsSync(join(sandbox.stateDir, "state.json")), true, "the state is kept");
  });

  it("never signals a pid whose start time is not the one recorded", () => {
    const sandbox = world();
    const other = spawn("sleep", ["60"]);
    try {
      writeStateFile(sandbox.stateDir, stateOf({ simPid: other.pid, simStart: 1 }));
      const result = run(TEARDOWN, [], sandbox.env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /is not the simulator; it is left alone/);
      assert.equal(isDead(other.pid ?? 0), false, "the unrelated process is still running");
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("never signals a state that records no start time, even for a live pid", () => {
    const sandbox = world();
    const other = spawn("sleep", ["60"]);
    try {
      writeStateFile(sandbox.stateDir, stateOf({ simPid: other.pid, simStart: undefined }));
      const result = run(TEARDOWN, [], sandbox.env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /left alone/);
      assert.equal(isDead(other.pid ?? 0), false);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("treats UserNotFoundException and robot-not-found as success", () => {
    const sandbox = world({ FAKE_DELETE_ERROR: "UserNotFoundException" });
    writeStateFile(sandbox.stateDir, stateOf({ simPid: undefined, simStart: undefined }));
    const result = run(TEARDOWN, [], { ...sandbox.env, FAKE_RETIRE: "retire-not-found.json" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /operator does not exist/);
    assert.match(result.stdout, /not registered or is already retired/);
    assert.equal(existsSync(sandbox.stateDir), false);
  });

  it("refuses a state file with an unexpected robot id and keeps it", () => {
    const sandbox = world();
    writeStateFile(sandbox.stateDir, stateOf({ robotId: "../escape" }));
    const result = run(TEARDOWN, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected value; it is kept/);
    assert.equal(callsOf(sandbox.log).length, 0, "no AWS call is made");
  });

  it("refuses a state file that names another site", () => {
    const sandbox = world();
    writeStateFile(sandbox.stateDir, stateOf({ siteId: "lyon-01" }));
    const result = run(TEARDOWN, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.equal(callsOf(sandbox.log).length, 0, "no AWS call is made");
  });

  it("exits 2 when it is given an argument", () => {
    const sandbox = world();
    const result = run(TEARDOWN, ["now"], sandbox.env);
    assert.equal(result.status, 2);
  });

  it("restores a telemetry consumer that the run enabled, and retires and deletes as usual", () => {
    const sandbox = world({ FAKE_CONSUMER_STATE: "Disabled" });
    const setup = run(SETUP, [], sandbox.env);
    assert.equal(setup.status, 0, setup.stderr);
    const teardown = run(TEARDOWN, [], sandbox.env);
    assert.equal(teardown.status, 0, teardown.stderr);
    assert.match(teardown.stdout, /telemetry consumer disabled again/);
    assert.equal(readFileSync(join(sandbox.fixtures, "consumer-state"), "utf8").trim(), "Disabled");
    const calls = callsOf(sandbox.log);
    assert.ok(
      calls.some(
        (line) => line.includes("update-event-source-mapping") && line.includes("--no-enabled"),
      ),
      "the consumer is disabled",
    );
    assert.ok(
      calls.some((line) => line.includes("admin-delete-user")),
      "the operator is deleted",
    );
    assert.equal(existsSync(sandbox.stateDir), false);
  });

  it("never disables a telemetry consumer that was enabled before the run", () => {
    const sandbox = world({ FAKE_CONSUMER_STATE: "Enabled" });
    const setup = run(SETUP, [], sandbox.env);
    assert.equal(setup.status, 0, setup.stderr);
    const teardown = run(TEARDOWN, [], sandbox.env);
    assert.equal(teardown.status, 0, teardown.stderr);
    assert.match(teardown.stdout, /was enabled before the run, left enabled/);
    assert.ok(
      !callsOf(sandbox.log).some((line) => line.includes("update-event-source-mapping")),
      "the consumer is never updated",
    );
    assert.equal(readFileSync(join(sandbox.fixtures, "consumer-state"), "utf8").trim(), "Enabled");
  });

  it("leaves the consumer alone when the state does not record it", () => {
    const sandbox = world();
    writeStateFile(sandbox.stateDir, stateOf({ simPid: undefined, simStart: undefined }));
    const result = run(TEARDOWN, [], { ...sandbox.env, FAKE_RETIRE: "retire-not-found.json" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !callsOf(sandbox.log).some((line) => line.includes("update-event-source-mapping")),
      "no consumer update without the record",
    );
  });

  it("refuses a consumer record that is not a boolean and keeps the state", () => {
    const sandbox = world();
    writeStateFile(sandbox.stateDir, stateOf({ consumerWasEnabled: "false" }));
    const result = run(TEARDOWN, [], sandbox.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected value; it is kept/);
    assert.equal(callsOf(sandbox.log).length, 0, "no AWS call is made");
  });

  it("runs the other steps when the consumer cannot be disabled, and keeps the state for a retry", () => {
    const sandbox = world({ FAKE_CONSUMER_STATE: "Disabled" });
    const setup = run(SETUP, [], sandbox.env);
    assert.equal(setup.status, 0, setup.stderr);
    const teardown = run(TEARDOWN, [], { ...sandbox.env, FAKE_CONSUMER_UPDATE_FAIL: "1" });
    assert.equal(teardown.status, 1);
    assert.match(teardown.stderr, /could not be disabled/);
    const calls = callsOf(sandbox.log);
    assert.ok(
      calls.some((line) => line.includes("admin-delete-user")),
      "the operator is deleted",
    );
    assert.ok(
      calls.some((line) => line.includes("lambda invoke")),
      "the robot is retired",
    );
    assert.equal(existsSync(join(sandbox.stateDir, "state.json")), true, "the state is kept");
    assert.equal(
      readState(sandbox.stateDir).consumerWasEnabled,
      false,
      "the retry still restores it",
    );
  });
});
