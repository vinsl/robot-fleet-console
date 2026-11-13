/* eslint-disable security/detect-non-literal-fs-filename -- the path comes from the environment of the test runner set by make e2e, never from a request */
/**
 * The e2e state file of one run, read by the Playwright tests (ADR 0069, D7).
 *
 * `scripts/e2e-setup.sh` writes the file and `scripts/e2e-teardown.sh` deletes it. The file is the only channel between
 * the setup and the test, so it is validated at this boundary, and a failure never shows its content: the file holds
 * the passwords of the run.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

/** The environment variable that holds the path of the state file. */
export const STATE_FILE_ENV = "E2E_STATE_FILE";

/*
 * The same shapes as the shell scripts (scripts/e2e-setup.sh, scripts/e2e-teardown.sh): a value that the setup could
 * not write is refused here too, so the test never runs against a state the teardown would refuse.
 */
const CONSOLE_URL_PATTERN = /^https:\/\/[a-z0-9.-]+$/;
const REGION_PATTERN = /^[a-z]{2}-[a-z-]+-[0-9]+$/;
const POOL_PATTERN = /^[a-z]{2}-[a-z-]+-[0-9]+_[A-Za-z0-9]+$/;
const EMAIL_PATTERN = /^e2e-[0-9]+-[0-9]+@example\.com$/;
const ROBOT_ID_PATTERN = /^e2e[0-9]+a[0-9]+-01$/;
const ROBOT_NAME_PATTERN = /^E2E [0-9]+a[0-9]+$/;
/** The only site the e2e run uses (scripts/e2e-setup.sh SITE_ID). */
const SITE_ID = "paris-01";

/**
 * The state of one run. Every field is written by the setup script; the teardown script reads the same file.
 *
 * `simPid` and `simStart` (the process start time, field 22 of /proc/PID/stat) are written by the setup after the
 * simulator starts. `consumerWasEnabled` records whether the telemetry consumer was enabled before the run; the setup
 * writes it before it enables the consumer. A strict object refuses unknown keys, so they are part of the schema. The
 * test runs only after the setup, so every field is required here.
 */
export const E2eStateSchema = z.strictObject({
  consoleUrl: z.string().regex(CONSOLE_URL_PATTERN),
  region: z.string().regex(REGION_PATTERN),
  userPoolId: z.string().regex(POOL_PATTERN),
  siteId: z.literal(SITE_ID),
  email: z.string().regex(EMAIL_PATTERN),
  temporaryPassword: z.string().min(1),
  password: z.string().min(1),
  robotId: z.string().regex(ROBOT_ID_PATTERN),
  robotName: z.string().regex(ROBOT_NAME_PATTERN),
  simPid: z.number().int().positive(),
  simStart: z.number().int().nonnegative(),
  consumerWasEnabled: z.boolean(),
});

/** The validated state of one e2e run. */
export type E2eState = z.infer<typeof E2eStateSchema>;

/**
 * Validates the parsed content of a state file.
 *
 * @param raw - The parsed JSON value of the file.
 * @returns The validated state.
 * @throws {Error} A fixed message, without the content: the zod issues would echo the secret values.
 */
export function parseState(raw: unknown): E2eState {
  const parsed = E2eStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${STATE_FILE_ENV} is not set or invalid`);
  }
  return parsed.data;
}

/**
 * Reads and validates the state file of the run.
 *
 * @param path - Path of the state file; defaults to the value of `E2E_STATE_FILE`.
 * @returns The validated state.
 * @throws {Error} A fixed message when the variable is unset, the file cannot be read or parsed, or its content is invalid.
 */
export function loadState(path: string | undefined = process.env.E2E_STATE_FILE): E2eState {
  if (path === undefined || path === "") {
    throw new Error(`${STATE_FILE_ENV} is not set or invalid`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${STATE_FILE_ENV} is not set or invalid`);
  }
  return parseState(raw);
}
