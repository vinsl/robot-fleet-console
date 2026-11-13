/**
 * Origin check of the WebSocket upgrade.
 *
 * A browser always sends `Origin`, so a page served from another site is refused before any token is spent.
 * A client that sends no `Origin` (a command-line tool) passes this check and must still hold a valid token:
 * the token, not the origin, is what authenticates the connection (THREAT_MODEL R41).
 */

/**
 * Tells whether an upgrade request may proceed from its origin.
 *
 * The comparison is exact: an origin is a scheme and a host, so a prefix or a suffix match would let a
 * look-alike host through.
 *
 * @param origin - The `Origin` header of the request, or undefined when the request carries none.
 * @param allowed - The origins the deployment allows.
 * @returns True when there is no origin, or the origin is in the allow-list.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}
