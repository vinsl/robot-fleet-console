/**
 * RFC 6238 time-based one-time passwords for the deployed e2e test (ADR 0069, D2).
 *
 * The e2e user enrols an authenticator through the real console, and the test computes the codes itself. The
 * implementation uses only `node:crypto`, so no dependency is added to a security-sensitive path: the test must
 * produce exactly the codes Cognito expects, and a small, reviewed HMAC routine is easier to trust than a
 * third-party package.
 */
import { createHmac } from "node:crypto";

/** Length of one TOTP time step in milliseconds (RFC 6238 default, the one Cognito uses). */
const STEP_MS = 30_000;

/** Longest time the test waits for a fresh step before it gives up; the step lasts 30 s, so one wait is enough. */
const MAX_WAIT_MS = 35_000;

/** Interval between two checks of the clock while waiting for the next step. */
const POLL_MS = 1_000;

/** The RFC 4648 base32 alphabet, upper case. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes a base32 secret as shown by the enrolment screen (RFC 4648).
 *
 * Case, spaces and `=` padding are ignored, because the console displays the key in groups and users copy it that way.
 * Any other character is refused: a misread `1` for `I` would otherwise produce a valid-looking but wrong key.
 *
 * @param input - The secret, for example `GEZD GNBV GY3T QOJQ`.
 * @returns The decoded bytes.
 * @throws {Error} When a character is outside the alphabet or the secret is empty.
 */
export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) {
    throw new Error("the base32 secret is empty");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error("the base32 secret holds a character outside the alphabet");
    }
    buffer = ((buffer << 5) | value) & 0xff_ff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Returns the RFC 6238 time step that contains an instant.
 *
 * @param atMs - Unix time in milliseconds.
 * @returns The step number, the same for every instant of one 30 s window.
 */
export function stepOf(atMs: number): number {
  return Math.floor(atMs / STEP_MS);
}

/**
 * Computes the one-time password of an instant (RFC 4226 dynamic truncation over HMAC-SHA1, RFC 6238 time).
 *
 * @param secretBase32 - The shared secret in base32, as shown by the enrolment screen.
 * @param atMs - Unix time in milliseconds.
 * @param digits - Number of digits of the code; Cognito uses 6.
 * @returns The code, left-padded with zeros to `digits` characters.
 */
export function totp(secretBase32: string, atMs: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepOf(atMs)));
  const hash = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  // The low nibble of the last byte picks the 4-byte window; its top bit is masked as RFC 4226 requires.
  const offset = hash.readUInt8(hash.length - 1) & 0x0f;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Waits for the next time step, then returns the code of that step.
 *
 * Cognito refuses a code it has already accepted in the same window. The sign-in that follows the enrolment must
 * therefore use a code of a later step than the one that confirmed the enrolment.
 *
 * @param secretBase32 - The shared secret in base32.
 * @param usedStep - The step of the code that was already used.
 * @param now - Clock in milliseconds; injected by the tests.
 * @param sleep - Waits for a number of milliseconds; injected by the tests.
 * @returns The code of a step after `usedStep`.
 * @throws {Error} When no new step starts within 35 s of waiting.
 */
export async function nextFreshCode(
  secretBase32: string,
  usedStep: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<string> {
  // The waited time is summed from the sleeps, not read from the clock, so a stuck clock cannot wait forever.
  let waited = 0;
  while (stepOf(now()) <= usedStep) {
    if (waited >= MAX_WAIT_MS) {
      throw new Error("no new TOTP step started within 35 seconds");
    }
    await sleep(POLL_MS);
    waited += POLL_MS;
  }
  return totp(secretBase32, now());
}

/**
 * Resolves after a delay; the default sleep of nextFreshCode.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that resolves when the timer fires.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
