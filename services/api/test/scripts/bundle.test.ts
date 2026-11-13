/**
 * Tests of the bundled robots function, as Lambda runs it: the bundle is built, then imported in a fresh
 * Node process with a fake environment. The same file checks the wiring rules of the handler that a unit
 * test cannot see, such as which SDK clients the X-Ray tracer wraps.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildHandlers } from "../../scripts/build.mjs";

/** Root of the API package. */
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Environment of the robots function, with fake values that match the function's grammar. */
const ROBOTS_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  IOT_DATA_ENDPOINT: "abc123-ats.iot.eu-west-3.amazonaws.com",
  IOT_CREDENTIALS_ENDPOINT: "abc123.credentials.iot.eu-west-3.amazonaws.com",
  RESOURCE_TAGS: JSON.stringify({
    project: "mfc",
    env: "demo",
    component: "robots",
    owner: "vincent",
  }),
};

/** Environment of the ingest functions. The values are fakes. */
const INGEST_ENVIRONMENT: Record<string, string> = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
  WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
};

/**
 * Runs a snippet in a fresh Node process that imports one function's bundle.
 *
 * @param functionName - The handler folder of the bundle, such as `robots`.
 * @param environment - The environment of the process. Only these variables are passed, so the test does not
 * depend on the developer's shell.
 * @returns The exit status and the output of the process.
 */
function importBundle(
  functionName: string,
  environment: Record<string, string>,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const bundle = pathToFileURL(path.join(packageRoot, "dist", functionName, "index.mjs")).href;
  const script = [
    `const module = await import(${JSON.stringify(bundle)});`,
    "process.stdout.write(`loaded ${typeof module.handler}`);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...environment },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("robots bundle", () => {
  beforeAll(async () => {
    await buildHandlers(packageRoot);
  }, 60_000);

  it("is emitted as dist/robots/index.mjs", async () => {
    const bundle = await readFile(path.join(packageRoot, "dist", "robots", "index.mjs"), "utf8");
    expect(bundle.length).toBeGreaterThan(0);
  });

  it("imports in a fresh process with a valid environment, without any call at load time", () => {
    const outcome = importBundle("robots", ROBOTS_ENVIRONMENT);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("loaded function");
  });

  it("refuses to load when a required variable is missing, and names only the variable", () => {
    const incomplete = Object.fromEntries(
      Object.entries(ROBOTS_ENVIRONMENT).filter(([name]) => name !== "IOT_DATA_ENDPOINT"),
    );

    const outcome = importBundle("robots", incomplete);

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("invalid environment: IOT_DATA_ENDPOINT");
    expect(outcome.stderr).not.toContain("mfc-demo-fleet");
  });
});

describe("ingest-events bundle", () => {
  beforeAll(async () => {
    await buildHandlers(packageRoot);
  }, 60_000);

  it("is emitted as dist/ingest-events/index.mjs", async () => {
    const bundle = await readFile(
      path.join(packageRoot, "dist", "ingest-events", "index.mjs"),
      "utf8",
    );
    expect(bundle.length).toBeGreaterThan(0);
  });

  it("imports in a fresh process with a valid environment, without any call at load time", () => {
    const outcome = importBundle("ingest-events", INGEST_ENVIRONMENT);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("loaded function");
  });

  it("refuses to load without its region, and names only the variable", () => {
    const outcome = importBundle("ingest-events", {});

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("invalid environment: AWS_REGION");
  });
});

describe("robots handler wiring", () => {
  it("never wraps the handler with the tracer, so a response never reaches X-Ray", async () => {
    const source = await readFile(path.join(packageRoot, "src", "handlers", "robots.ts"), "utf8");

    expect(source).not.toMatch(/captureLambdaHandler\(/);
  });

  it("wraps the DynamoDB and Kinesis Video clients with the tracer, and no IoT client", async () => {
    const source = await readFile(path.join(packageRoot, "src", "handlers", "robots.ts"), "utf8");

    const wrapped = [...source.matchAll(/captureAWSv3Client\(\s*new (\w+)\(/g)].map(
      (match) => match[1],
    );
    expect(wrapped).toStrictEqual(["DynamoDBClient", "KinesisVideoClient"]);
  });
});

describe("ingest-events handler wiring", () => {
  it("never wraps the handler with the tracer, so the deliveries are not copied to X-Ray", async () => {
    const source = await readFile(
      path.join(packageRoot, "src", "handlers", "ingest-events.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/captureLambdaHandler\(/);
  });
});

describe("ingest-telemetry bundle", () => {
  beforeAll(async () => {
    await buildHandlers(packageRoot);
  }, 60_000);

  it("is emitted as dist/ingest-telemetry/index.mjs", async () => {
    const bundle = await readFile(
      path.join(packageRoot, "dist", "ingest-telemetry", "index.mjs"),
      "utf8",
    );
    expect(bundle.length).toBeGreaterThan(0);
  });

  it("imports in a fresh process with a valid environment, without any call at load time", () => {
    const outcome = importBundle("ingest-telemetry", INGEST_ENVIRONMENT);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("loaded function");
  });

  it("refuses to load without its environment, and names only the variables", () => {
    const outcome = importBundle("ingest-telemetry", {
      AWS_REGION: "eu-west-3",
    });

    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("invalid environment: FLEET_TABLE_NAME");
  });
});

describe("ingest-telemetry handler wiring", () => {
  it("never wraps the handler with the tracer, so the queue bodies are not copied to X-Ray", async () => {
    const source = await readFile(
      path.join(packageRoot, "src", "handlers", "ingest-telemetry.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/captureLambdaHandler\(/);
  });
});
