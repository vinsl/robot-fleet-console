/**
 * API health indicator of the status line: polls `GET /health` and reports whether the API answers and how fast.
 */
import { useQuery } from "@tanstack/react-query";
import { HealthResponseSchema } from "@mfc/protocol";
import { useServices } from "../app/services";
import { API_PATHS } from "./http-client";

/** Interval between two health checks. Long enough to keep the API quiet, short enough to notice an outage. */
const HEALTH_POLL_MS = 15_000;

/** Result of the latest health check. */
export interface ApiHealth {
  /** `true` when the latest check succeeded. */
  readonly ok: boolean;
  /** Round-trip time of the latest successful check, or `null` when the last check failed. */
  readonly latencyMs: number | null;
}

/**
 * Polls the API health route every {@link HEALTH_POLL_MS} while the page is visible.
 *
 * @returns The latest health result.
 */
export function useApiHealth(): ApiHealth {
  const { api } = useServices();
  const query = useQuery({
    queryKey: ["api-health"],
    queryFn: async (): Promise<number> => {
      const started = performance.now();
      await api.get(API_PATHS.health, HealthResponseSchema);
      return Math.round(performance.now() - started);
    },
    refetchInterval: HEALTH_POLL_MS,
    refetchIntervalInBackground: false,
  });

  return {
    ok: query.isSuccess,
    latencyMs: query.isSuccess ? query.data : null,
  };
}
