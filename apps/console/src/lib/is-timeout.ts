/**
 * Tells whether a thrown value ends a request because its time limit ran out.
 *
 * Every request of the console sets its limit with `AbortSignal.timeout`, which rejects with a `TimeoutError`; an
 * `AbortError` is accepted too, so a request cut short by the browser counts the same way. The check is by name,
 * because a `DOMException` from another realm is not an `instanceof` match.
 *
 * @module lib/is-timeout
 */

/**
 * Tells whether a thrown value is the request timeout or an abort.
 *
 * @param error - The value thrown by fetch.
 * @returns `true` for a timeout or an abort.
 */
export function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
