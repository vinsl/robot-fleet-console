/**
 * UUIDv7 (RFC 9562, section 5.7): a time-ordered identifier used for message and boot identifiers.
 *
 * Time ordering matters: a consumer can compare two identifiers as strings to tell which one was
 * issued first. The generator is implemented here rather than taken from a dependency because it
 * is about twenty lines and the layout is easy to test exhaustively.
 */
import { z } from "zod";

/** Largest millisecond timestamp that fits the 48-bit field of a UUIDv7. */
const MAX_UNIX_MS = 2 ** 48 - 1;

/** Random bytes consumed per identifier: 2 for `rand_a`, 1 bit-packed with the variant, 7 for `rand_b`. */
const RANDOM_BYTES = 10;

/**
 * Accepts a UUID version 7 in the RFC 9562 variant, written in lowercase only.
 *
 * Lowercase is required because identifiers are compared as strings (replay, ordering): two spellings
 * of one identifier would be two different keys. The generator below always writes lowercase.
 */
export const Uuidv7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** A validated UUIDv7 string. */
export type Uuidv7 = z.infer<typeof Uuidv7Schema>;

/**
 * Draws random bytes from the Web Crypto API, which exists in Node.js and in browsers.
 *
 * @param count - Number of bytes to draw.
 * @returns A fresh array of cryptographically strong random bytes.
 */
function webCryptoRandom(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

/**
 * Generates a UUIDv7 string in lowercase hexadecimal.
 *
 * @param nowMs - Unix time in milliseconds, an integer in `[0, 2^48)`. Defaults to the current time.
 * @param random - Source of `count` random bytes. Injected so tests can pin the random bits.
 * @returns The identifier in the canonical 8-4-4-4-12 form.
 * @throws RangeError If `nowMs` is out of range, or `random` does not return the requested count.
 */
export function uuidv7(
  nowMs: number = Date.now(),
  random: (count: number) => Uint8Array = webCryptoRandom,
): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_UNIX_MS) {
    throw new RangeError("nowMs must be an integer in [0, 2^48)");
  }
  const entropy = random(RANDOM_BYTES);
  if (entropy.length !== RANDOM_BYTES) {
    throw new RangeError("random must return 10 bytes");
  }

  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  // The 48-bit timestamp is big-endian: a 32-bit high word, then a 16-bit low word. Splitting by
  // division keeps the arithmetic exact up to 2^53, which the 32-bit bitwise operators would not.
  view.setUint32(0, Math.floor(nowMs / 2 ** 16));
  view.setUint16(4, nowMs % 2 ** 16);
  // Bytes 6 to 15 hold the version, the random bits and the variant. The random bytes are copied in
  // first, then the version nibble (0111) and the variant bits (10) overwrite their reserved bits.
  bytes.set(entropy, 6);
  view.setUint8(6, 0x70 | (view.getUint8(6) & 0x0f));
  view.setUint8(8, 0x80 | (view.getUint8(8) & 0x3f));

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
