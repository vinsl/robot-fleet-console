/**
 * Exponential backoff with full jitter, used when reconnecting to the realtime channel.
 *
 * Full jitter (a uniform draw between zero and the capped exponential) spreads
 * reconnection attempts from many clients over time, avoiding a thundering herd
 * after an outage.
 */

/** Parameters of the backoff curve. */
export interface BackoffOptions {
  /** Delay of the first retry, in milliseconds. Must be finite and strictly positive. */
  readonly baseMs: number;
  /** Upper bound of any delay, in milliseconds. Must be finite and at least `baseMs`. */
  readonly capMs: number;
}

/**
 * Computes the delay before a reconnection attempt.
 *
 * @param attempt - Zero-based attempt number. Must be an integer greater than or equal to zero.
 * @param options - Base delay and cap, in milliseconds.
 * @param random - Source of randomness returning a value in `[0, 1)`. Injected for tests.
 * @returns A whole number of milliseconds in `[0, capMs)`.
 * @throws {RangeError} When any input is outside its documented domain.
 */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt must be an integer >= 0, got ${String(attempt)}`);
  }
  if (!Number.isFinite(options.baseMs) || options.baseMs <= 0) {
    throw new RangeError(`baseMs must be a finite number > 0, got ${String(options.baseMs)}`);
  }
  // Written as a negated condition so that NaN, which fails every comparison, is rejected.
  // An infinite cap is rejected too: it would let `baseMs * 2 ** 64` overflow into NaN.
  if (!(Number.isFinite(options.capMs) && options.capMs >= options.baseMs)) {
    throw new RangeError(`capMs must be finite and >= baseMs, got ${String(options.capMs)}`);
  }

  const draw = random();
  if (!(draw >= 0 && draw < 1)) {
    throw new RangeError(`random() must return a value in [0, 1), got ${String(draw)}`);
  }

  // Capping the exponent at 64 keeps 2 ** n finite for any attempt count, so a long
  // outage cannot overflow the arithmetic and produce NaN.
  const exponent = Math.min(attempt, 64);
  const ceiling = Math.min(options.capMs, options.baseMs * 2 ** exponent);
  return Math.floor(draw * ceiling);
}
