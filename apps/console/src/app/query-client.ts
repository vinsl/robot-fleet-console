/**
 * Query client defaults: one retry for transient failures and a short stale time, so that navigating between
 * views does not repeat requests that were answered a moment ago.
 */
import { QueryClient } from "@tanstack/react-query";

/** Time a query result stays fresh, in milliseconds. */
const STALE_TIME_MS = 5_000;

/**
 * Creates the query client of the console.
 *
 * @returns A new query client.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: STALE_TIME_MS,
      },
    },
  });
}
