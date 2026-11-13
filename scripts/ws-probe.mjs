/**
 * Live telemetry probe for the M5 load check (design M5 section 11).
 *
 * The probe takes a single-use token from `scripts/ws-token.sh`, connects as an operator console does,
 * subscribes to one site and reads server frames for a fixed time. Every frame is checked against the
 * protocol schema, and the end-to-end latency of each fleet sample is measured from the sample's own
 * timestamp to the moment the probe receives it. The first `--warmup-seconds` are read but not measured.
 *
 * The schemas are TypeScript sources in packages/protocol, so the probe runs under the tsx loader, from
 * that package directory (its tsx and zod are resolved from there):
 *   cd packages/protocol && node --import tsx ../../scripts/ws-probe.mjs --site-id paris-01 \
 *     --sub <uuid> --role Operator --seconds 600 --warmup-seconds 60
 *
 * Output: one JSON summary line on standard output. Exit status: 0 PASS, 1 FAIL, 2 usage error.
 * The token is never printed, logged or put in an error message, and the stderr of the token script is
 * not repeated, because it may hold the request it failed on.
 *
 * `--self-test` runs the probe against a local fake server in four scenarios, with no AWS call, and
 * prints one JSON line with the outcome of each. It exits 0 when every scenario behaves as expected.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  RoleSchema,
  SiteIdSchema,
  WS_MAX_SERVER_FRAME_BYTES,
  WsServerMessageSchema,
  WsTokenResponseSchema,
} from "../packages/protocol/src/index.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TOKEN_SCRIPT = path.join(REPO_ROOT, "scripts", "ws-token.sh");

const DEFAULT_SECONDS = 60;
const DEFAULT_WARMUP_SECONDS = 60;
const DEFAULT_MAX_P95_MS = 1500;
/** Bounds of the numeric options: what one run may ask for. */
const RANGES = { seconds: [1, 3600], warmupSeconds: [0, 600], maxP95Ms: [1, 60000] };

const TOKEN_TIMEOUT_MS = 20_000;
const TOKEN_OUTPUT_MAX_BYTES = 4096;
const CONNECT_TIMEOUT_MS = 10_000;
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SELF_TEST_TOKEN = "self-test-token-not-a-credential";
const SELF_TEST_SITE = "paris-01";
const SELF_TEST_ROBOT = "sim-01";
const SELF_TEST_BOOT_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const USAGE =
  "usage: ws-probe.mjs --site-id ID --sub SUB --role Admin|Operator|Viewer " +
  "[--seconds 60] [--warmup-seconds 60] [--max-p95-ms 1500]\n" +
  "       ws-probe.mjs --self-test";

/** A failure with a stable reason code. The message is for the operator and never carries a secret. */
class ProbeError extends Error {
  /**
   * @param {string} code Reason code printed in the summary.
   * @param {string} message Text for the operator.
   */
  constructor(code, message) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
  }
}

/**
 * Builds the usage error of a bad command line.
 * @param {string} message What is wrong, in one sentence.
 * @returns {ProbeError}
 */
function usage(message) {
  return new ProbeError("USAGE", message);
}

/**
 * Reads a required option that must match a protocol schema.
 * @param {Map<string, string>} raw Options as given on the command line.
 * @param {string} flag Option name.
 * @param {import("zod").ZodType} schema Protocol schema of the value.
 * @returns {unknown} The parsed value.
 */
function required(raw, flag, schema) {
  const parsed = schema.safeParse(raw.get(flag));
  if (!parsed.success) {
    throw usage(`${flag} is missing or not valid`);
  }
  return parsed.data;
}

/**
 * Reads a numeric option within its range, or returns the default when it is absent.
 * @param {Map<string, string>} raw Options as given on the command line.
 * @param {string} flag Option name.
 * @param {number[]} range Inclusive minimum and maximum.
 * @param {number} fallback Value used when the option is absent.
 * @returns {number}
 */
function bounded(raw, flag, range, fallback) {
  const text = raw.get(flag);
  if (text === undefined) {
    return fallback;
  }
  if (!/^\d{1,6}$/.test(text)) {
    throw usage(`${flag} must be a whole number`);
  }
  const value = Number(text);
  const [min, max] = range;
  if (min === undefined || max === undefined || value < min || value > max) {
    throw usage(`${flag} must be from ${String(min)} to ${String(max)}`);
  }
  return value;
}

/**
 * Reads the command line. Unknown, repeated or valueless options are usage errors, and every value is
 * checked against the protocol before anything is sent.
 * @param {string[]} argv Arguments after the script name.
 * @returns {{selfTest: true} | {selfTest: false, siteId: string, sub: string, role: string, seconds: number, warmupSeconds: number, maxP95Ms: number}}
 */
function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") {
    return { selfTest: true };
  }
  const valueFlags = new Set([
    "--site-id",
    "--sub",
    "--role",
    "--seconds",
    "--warmup-seconds",
    "--max-p95-ms",
  ]);
  const raw = new Map();
  for (let start = 0; start < argv.length; start += 2) {
    // Destructuring reads the pair; an index into argv would trip the object-injection rule.
    const [flag = "", value] = argv.slice(start, start + 2);
    if (!valueFlags.has(flag)) {
      throw usage(`unknown option: ${flag}`);
    }
    if (raw.has(flag)) {
      throw usage(`${flag} is given twice`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw usage(`${flag} needs a value`);
    }
    raw.set(flag, value);
  }
  const siteId = required(raw, "--site-id", SiteIdSchema);
  const role = required(raw, "--role", RoleSchema);
  const sub = raw.get("--sub");
  if (typeof sub !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(sub)) {
    throw usage("--sub is missing or not valid");
  }
  const seconds = bounded(raw, "--seconds", RANGES.seconds, DEFAULT_SECONDS);
  const warmupSeconds = bounded(
    raw,
    "--warmup-seconds",
    RANGES.warmupSeconds,
    DEFAULT_WARMUP_SECONDS,
  );
  if (warmupSeconds >= seconds) {
    throw usage("--warmup-seconds must be smaller than --seconds");
  }
  const maxP95Ms = bounded(raw, "--max-p95-ms", RANGES.maxP95Ms, DEFAULT_MAX_P95_MS);
  return {
    selfTest: false,
    siteId: String(siteId),
    sub,
    role: String(role),
    seconds,
    warmupSeconds,
    maxP95Ms,
  };
}

/**
 * Obtains a single-use token and the WebSocket URL from `scripts/ws-token.sh`, the one place that asks
 * the cloud for a token, so that the probe takes the same path as an operator. The output is checked
 * against the protocol response, restricted to the two fields the probe needs. The environment variable
 * WS_PROBE_TOKEN_SCRIPT exists only so that the tests can replace the script.
 * @param {{siteId: string, sub: string, role: string}} args Validated options.
 * @returns {Promise<{url: string, token: string}>}
 */
async function fetchConnection(args) {
  const script = process.env.WS_PROBE_TOKEN_SCRIPT ?? DEFAULT_TOKEN_SCRIPT;
  let stdout;
  try {
    // A fixed argument list of validated values: no shell is involved.
    const result = await execFileAsync(
      script,
      ["--site-id", args.siteId, "--sub", args.sub, "--role", args.role],
      { timeout: TOKEN_TIMEOUT_MS, maxBuffer: TOKEN_OUTPUT_MAX_BYTES, encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch {
    throw new ProbeError(
      "TOKEN_UNAVAILABLE",
      "ws-token.sh did not issue a token; run aws sso login, then retry",
    );
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ProbeError(
      "TOKEN_RESPONSE_INVALID",
      "ws-token.sh printed something other than the token response",
    );
  }
  const parsed = WsTokenResponseSchema.pick({ url: true, token: true }).loose().safeParse(json);
  if (!parsed.success) {
    throw new ProbeError(
      "TOKEN_RESPONSE_INVALID",
      "the token response does not match the protocol",
    );
  }
  return { url: parsed.data.url, token: parsed.data.token };
}

/**
 * Parses one server frame. Anything that is not a valid protocol frame, including a frame over the
 * server frame bound, yields undefined and is counted as invalid without being inspected further.
 * @param {unknown} data The `data` of a message event.
 * @returns {import("zod").infer<typeof WsServerMessageSchema> | undefined}
 */
function parseFrame(data) {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > WS_MAX_SERVER_FRAME_BYTES) {
    return undefined;
  }
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = WsServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Returns the value at a percentile of an ascending list, by the nearest-rank method.
 * @param {number[]} sorted Non-empty list sorted ascending.
 * @param {number} percent Percentile from 0 to 100.
 * @returns {number}
 */
function percentile(sorted, percent) {
  const rank = Math.ceil((percent / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1] ?? 0;
}

/**
 * Accumulates what one probe run has seen. A frame is checked here before it reaches the statistics, and
 * a sample is identified by (robot, boot, seq): a repeated identifier is a duplicate, and a sample that is
 * not newer than the last one of its robot and boot is out of order. Latency is taken only after the
 * warm-up, and only from samples that are not duplicates.
 */
class Recorder {
  /** @param {{seconds: number, warmupSeconds: number}} args Validated options. */
  constructor(args) {
    this.warmupSeconds = args.warmupSeconds;
    this.warmupEndMs = Number.POSITIVE_INFINITY;
    this.frames = { total: 0, invalid: 0, byType: new Map() };
    this.latencies = [];
    this.robots = new Set();
    this.keys = new Set();
    this.lastByRobot = new Map();
    this.counts = { duplicates: 0, outOfOrder: 0, seqGaps: 0 };
    this.lastDeltaMs = undefined;
    this.maxDeltaGapMs = 0;
  }

  /**
   * Starts the measured window: the warm-up ends this many seconds after the subscription.
   * @param {number} startedMs Epoch milliseconds of the subscription.
   * @returns {void}
   */
  start(startedMs) {
    this.warmupEndMs = startedMs + this.warmupSeconds * 1000;
  }

  /**
   * Checks and counts one server frame.
   * @param {unknown} data The `data` of a message event.
   * @param {number} nowMs Epoch milliseconds of the receipt.
   * @returns {void}
   */
  observe(data, nowMs) {
    this.frames.total += 1;
    const message = parseFrame(data);
    if (message === undefined) {
      this.frames.invalid += 1;
      return;
    }
    this.frames.byType.set(message.type, (this.frames.byType.get(message.type) ?? 0) + 1);
    if (message.type === "fleet.delta") {
      this.observeDelta(message.robots, nowMs);
    }
  }

  /**
   * Counts the samples of one fleet delta and the time since the previous delta.
   * @param {{robotId: string, bootId: string, seq: number, ts: string}[]} samples Samples of the frame.
   * @param {number} nowMs Epoch milliseconds of the receipt.
   * @returns {void}
   */
  observeDelta(samples, nowMs) {
    if (this.lastDeltaMs !== undefined && nowMs >= this.warmupEndMs) {
      this.maxDeltaGapMs = Math.max(this.maxDeltaGapMs, nowMs - this.lastDeltaMs);
    }
    this.lastDeltaMs = nowMs;
    for (const sample of samples) {
      this.observeSample(sample, nowMs);
    }
  }

  /**
   * Counts one robot sample: duplicate, order, gap, and latency when it is measured.
   * @param {{robotId: string, bootId: string, seq: number, ts: string}} sample A validated sample.
   * @param {number} nowMs Epoch milliseconds of the receipt.
   * @returns {void}
   */
  observeSample(sample, nowMs) {
    this.robots.add(sample.robotId);
    const key = `${sample.robotId}|${sample.bootId}|${sample.seq}`;
    if (this.keys.has(key)) {
      this.counts.duplicates += 1;
      return;
    }
    this.keys.add(key);
    const previous = this.lastByRobot.get(sample.robotId);
    if (previous === undefined || sample.bootId > previous.bootId) {
      this.lastByRobot.set(sample.robotId, { bootId: sample.bootId, seq: sample.seq });
    } else if (sample.bootId === previous.bootId && sample.seq > previous.seq) {
      this.counts.seqGaps += sample.seq - previous.seq - 1;
      this.lastByRobot.set(sample.robotId, { bootId: sample.bootId, seq: sample.seq });
    } else {
      this.counts.outOfOrder += 1;
    }
    if (nowMs >= this.warmupEndMs) {
      this.latencies.push(nowMs - Date.parse(sample.ts));
    }
  }

  /**
   * Latency statistics of the measured samples. Negative values are kept: they reveal a clock that runs
   * ahead of the probe, which is the offset the runbook asks the operator to check.
   * @returns {{min: number, p50: number, p95: number, p99: number, max: number} | null}
   */
  latencyStats() {
    if (this.latencies.length === 0) {
      return null;
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }

  /**
   * Builds the summary and the verdict. A run that ended by itself is judged on its samples; a run that
   * failed before or during the connection is FAIL with that reason only.
   * @param {{siteId: string, seconds: number, warmupSeconds: number, maxP95Ms: number}} args Validated options.
   * @param {{code: string, closeCode?: number} | null} failure The failure that stopped the run, if any.
   * @returns {Record<string, unknown>}
   */
  summarise(args, failure) {
    const reasons = [];
    if (failure !== null) {
      reasons.push(failure.code);
    }
    if (this.frames.invalid > 0) {
      reasons.push("INVALID_FRAMES");
    }
    const latencyMs = this.latencyStats();
    if (failure === null && latencyMs === null) {
      reasons.push("NO_SAMPLES");
    }
    if (latencyMs !== null && latencyMs.p95 > args.maxP95Ms) {
      reasons.push("P95_ABOVE_THRESHOLD");
    }
    return {
      verdict: reasons.length === 0 ? "PASS" : "FAIL",
      reasons,
      siteId: args.siteId,
      seconds: args.seconds,
      warmupSeconds: args.warmupSeconds,
      maxP95Ms: args.maxP95Ms,
      closeCode: failure?.closeCode ?? null,
      frames: {
        total: this.frames.total,
        invalid: this.frames.invalid,
        byType: Object.fromEntries(this.frames.byType),
      },
      samples: {
        robots: this.robots.size,
        measured: this.latencies.length,
        ...this.counts,
      },
      latencyMs,
      maxDeltaGapMs: this.maxDeltaGapMs,
    };
  }
}

/**
 * Connects, subscribes and reads frames for `args.seconds`, then closes. The promise always resolves with
 * a summary: a connection failure is a FAIL verdict, not an exception.
 * @param {{url: string, token: string}} connection The WebSocket URL and the single-use token.
 * @param {{siteId: string, seconds: number, warmupSeconds: number, maxP95Ms: number}} args Validated options.
 * @returns {Promise<Record<string, unknown>>}
 */
function runProbe(connection, args) {
  return new Promise((resolve) => {
    const url = new URL(connection.url);
    url.searchParams.set("token", connection.token);
    const recorder = new Recorder(args);
    const socket = new WebSocket(url);
    let done = false;
    let connectTimer;
    let endTimer;
    /** @param {{code: string, closeCode?: number} | null} failure */
    const finish = (failure) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(endTimer);
      socket.close(1000, "probe finished");
      resolve(recorder.summarise(args, failure));
    };
    connectTimer = setTimeout(() => finish({ code: "CONNECTION_FAILED" }), CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      recorder.start(Date.now());
      socket.send(JSON.stringify({ type: "subscribe", siteId: args.siteId }));
      endTimer = setTimeout(() => finish(null), args.seconds * 1000);
    });
    socket.addEventListener("message", (event) => {
      if (!done) {
        recorder.observe(event.data, Date.now());
      }
    });
    // The error event carries no detail the probe may print, so only the reason code is kept.
    socket.addEventListener("error", () => finish({ code: "CONNECTION_FAILED" }));
    socket.addEventListener("close", (event) =>
      finish({ code: "CONNECTION_CLOSED", closeCode: event.code }),
    );
  });
}

/**
 * Encodes one unmasked text frame, as a server sends it (RFC 6455, section 5.2).
 * @param {string} text The payload.
 * @returns {Buffer}
 */
function textFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Writes the frames of one self-test scenario on an upgraded socket. The sequence is 1, 2, a repeat of 2
 * (a duplicate), then 6, 7, ... (a gap). A fleet sample is stamped `latencyMs` before it is sent.
 * @param {import("node:net").Socket} socket The upgraded socket.
 * @param {string} mode Scenario name.
 * @param {Set<NodeJS.Timeout>} timers Timers to clear when the server closes.
 * @returns {void}
 */
function writeScenarioFrames(socket, mode, timers) {
  const latencyMs = mode === "late" ? 2000 : 120;
  const send = (message) => {
    socket.write(textFrame(JSON.stringify(message)));
  };
  send({
    type: "fleet.snapshot",
    siteId: SELF_TEST_SITE,
    sentAt: new Date().toISOString(),
    robots: [],
  });
  if (mode === "invalid") {
    send({ type: "unknown" });
  }
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const seq = tick <= 2 ? tick : tick === 3 ? 2 : tick + 3;
    send({
      type: "fleet.delta",
      siteId: SELF_TEST_SITE,
      sentAt: new Date().toISOString(),
      robots: [
        {
          robotId: SELF_TEST_ROBOT,
          bootId: SELF_TEST_BOOT_ID,
          seq,
          ts: new Date(Date.now() - latencyMs).toISOString(),
          x: 1.5,
          y: 2.5,
          heading: 0.5,
          speed: 0.8,
          battery: 80,
          state: "MOVING",
        },
      ],
    });
  }, 100);
  timers.add(timer);
}

/**
 * Answers the upgrade request of the fake server. A valid token gets the handshake and the scenario
 * frames; anything else gets a 403, which the probe reports as a failed connection.
 * @param {import("node:http").IncomingMessage} request The upgrade request.
 * @param {import("node:net").Socket} socket The raw socket.
 * @param {string} mode Scenario name.
 * @param {Set<NodeJS.Timeout>} timers Timers of the scenario.
 * @returns {void}
 */
function handleUpgrade(request, socket, mode, timers) {
  // A client that leaves mid-frame is the client's concern, not a failure of the scenario.
  socket.on("error", () => {});
  socket.on("data", () => {});
  const token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  const key = request.headers["sec-websocket-key"];
  if (mode === "refuse" || token !== SELF_TEST_TOKEN || typeof key !== "string") {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(`${key}${WS_ACCEPT_GUID}`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  writeScenarioFrames(socket, mode, timers);
}

/**
 * Starts a fake WebSocket server on the loopback interface, so that the self-test exercises the real
 * client path without any AWS call.
 * @param {string} mode Scenario name: healthy, invalid, late or refuse.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function startFakeServer(mode) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const timers = new Set();
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket) => handleUpgrade(request, socket, mode, timers));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}/live`,
        close: () =>
          new Promise((done) => {
            for (const timer of timers) {
              clearInterval(timer);
            }
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Runs the four self-test scenarios against the fake server and checks each outcome.
 * @returns {Promise<{selfTest: "PASS" | "FAIL", scenarios: Record<string, "PASS" | "FAIL">}>}
 */
async function selfTest() {
  const probeArgs = {
    siteId: SELF_TEST_SITE,
    seconds: 1,
    warmupSeconds: 0,
    maxP95Ms: DEFAULT_MAX_P95_MS,
  };
  const scenarios = [
    {
      name: "healthy",
      mode: "healthy",
      check: (s) =>
        s.verdict === "PASS" &&
        s.samples.duplicates === 1 &&
        s.samples.seqGaps >= 1 &&
        s.frames.invalid === 0 &&
        s.latencyMs !== null &&
        s.latencyMs.p95 >= 100,
    },
    {
      name: "invalid-frame",
      mode: "invalid",
      check: (s) => s.verdict === "FAIL" && s.reasons.includes("INVALID_FRAMES"),
    },
    {
      name: "latency-above-threshold",
      mode: "late",
      check: (s) => s.verdict === "FAIL" && s.reasons.includes("P95_ABOVE_THRESHOLD"),
    },
    {
      name: "refused-handshake",
      mode: "refuse",
      check: (s) => s.verdict === "FAIL" && s.reasons.includes("CONNECTION_FAILED"),
    },
  ];
  const results = new Map();
  for (const scenario of scenarios) {
    const server = await startFakeServer(scenario.mode);
    try {
      const summary = await runProbe({ url: server.url, token: SELF_TEST_TOKEN }, probeArgs);
      results.set(scenario.name, scenario.check(summary) ? "PASS" : "FAIL");
    } finally {
      await server.close();
    }
  }
  const allPass = [...results.values()].every((outcome) => outcome === "PASS");
  return { selfTest: allPass ? "PASS" : "FAIL", scenarios: Object.fromEntries(results) };
}

/**
 * Runs one probe against the deployed API and returns its summary. Every failure becomes a FAIL summary
 * with its reason code, so the caller always gets a JSON line to record.
 * @param {{siteId: string, sub: string, role: string, seconds: number, warmupSeconds: number, maxP95Ms: number}} args Validated options.
 * @returns {Promise<Record<string, unknown>>}
 */
async function probeOnce(args) {
  try {
    const connection = await fetchConnection(args);
    return await runProbe(connection, args);
  } catch (error) {
    if (error instanceof ProbeError) {
      return new Recorder(args).summarise(args, { code: error.code });
    }
    process.stderr.write(
      `ws-probe: unexpected error (${error instanceof Error ? error.name : "unknown"})\n`,
    );
    return new Recorder(args).summarise(args, { code: "UNEXPECTED" });
  }
}

/**
 * Entry point: parses the command line, runs the self-test or one probe, and prints the JSON line.
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} The exit status.
 */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof ProbeError)) {
      throw error;
    }
    process.stderr.write(`ws-probe: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.selfTest) {
    const outcome = await selfTest();
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return outcome.selfTest === "PASS" ? 0 : 1;
  }
  const summary = await probeOnce(args);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.verdict === "PASS" ? 0 : 1;
}

main(process.argv.slice(2))
  .then((status) => {
    process.exitCode = status;
  })
  .catch(() => {
    process.stderr.write("ws-probe: failed before the probe started\n");
    process.exitCode = 1;
  });
