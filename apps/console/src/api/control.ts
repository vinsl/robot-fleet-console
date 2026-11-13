/**
 * Control API: route builders, query hooks and request functions of the robot control plane (commands, lock,
 * robot registry list and demo mode).
 *
 * The registry, the lock and the demo state are server state, so they live in the TanStack Query cache. The
 * command results and the lock changes are live frames, so they live in the Zustand stores of `control/`
 * instead (ADR 0066). Every request is built from validated identifiers, and every answer is checked against
 * its protocol schema before it reaches the UI.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  CommandResponseSchema,
  DEMO_SITE_ID,
  DemoStateSchema,
  LockActionResponseSchema,
  LockStateSchema,
  RobotIdSchema,
  RobotListResponseSchema,
  type CommandRequest,
  type CommandResponse,
  type DemoState,
  type LockActionResponse,
  type LockState,
  type RobotId,
  type RobotSummary,
  type SiteId,
} from "@mfc/protocol";
import { useServices } from "../app/services";
import type { ApiClient, SitePath } from "./http-client";
import { sitePaths } from "./site";

/** Query key prefix of the robot registry list. */
export const ROBOTS_KEY = "control-robots";

/** Query key prefix of the lock state of one robot. */
export const LOCK_KEY = "control-lock";

/** Query key prefix of the demo state. */
export const DEMO_KEY = "control-demo";

/** How often the registry list is refetched, so that a robot registered elsewhere shows up without a reload. */
const REGISTRY_REFETCH_MS = 60_000;

/** How often the demo state is refetched, so that the banner follows a change made by another admin. */
const DEMO_REFETCH_MS = 15_000;

/**
 * Checks a robot identifier before it becomes a path segment.
 *
 * @param robotId - Candidate identifier.
 * @returns The identifier, unchanged.
 * @throws TypeError When the identifier does not match the protocol grammar.
 */
function checkedRobotId(robotId: RobotId): RobotId {
  if (!RobotIdSchema.safeParse(robotId).success) {
    throw new TypeError("invalid robot id");
  }
  return robotId;
}

/** Builders of the control routes. Each returns a path the HTTP client accepts. */
export const controlPaths = {
  /**
   * @param siteId - Site identifier.
   * @returns `/sites/{siteId}/robots`.
   */
  robots: (siteId: SiteId): SitePath => `${sitePaths.site(siteId)}/robots`,
  /**
   * @param siteId - Site identifier.
   * @param robotId - Robot identifier, checked before it becomes a segment.
   * @returns `/sites/{siteId}/robots/{robotId}/lock`.
   */
  lock: (siteId: SiteId, robotId: RobotId): SitePath =>
    `${sitePaths.site(siteId)}/robots/${checkedRobotId(robotId)}/lock`,
  /**
   * @param siteId - Site identifier.
   * @param robotId - Robot identifier, checked before it becomes a segment.
   * @returns `/sites/{siteId}/robots/{robotId}/lock/release`.
   */
  lockRelease: (siteId: SiteId, robotId: RobotId): SitePath =>
    `${sitePaths.site(siteId)}/robots/${checkedRobotId(robotId)}/lock/release`,
  /**
   * @param siteId - Site identifier.
   * @param robotId - Robot identifier, checked before it becomes a segment.
   * @returns `/sites/{siteId}/robots/{robotId}/commands`.
   */
  commands: (siteId: SiteId, robotId: RobotId): SitePath =>
    `${sitePaths.site(siteId)}/robots/${checkedRobotId(robotId)}/commands`,
  /**
   * @param siteId - Site identifier.
   * @returns `/sites/{siteId}/demo`.
   */
  demo: (siteId: SiteId): SitePath => `${sitePaths.site(siteId)}/demo`,
};

/**
 * Sends one controlled command. The caller mints the command identifier, so a retry is a new call with a new
 * identifier (ADR 0062).
 *
 * @param api - The API client.
 * @param robotId - Target robot.
 * @param request - The command, with its identifier.
 * @returns The validated answer.
 * @throws {ApiError} On any failure.
 */
export function postCommand(
  api: ApiClient,
  robotId: RobotId,
  request: CommandRequest,
): Promise<CommandResponse> {
  return api.post(controlPaths.commands(DEMO_SITE_ID, robotId), request, CommandResponseSchema);
}

/**
 * Asks for the lock of a robot. The cloud keeps the lock token; the answer never carries it.
 *
 * @param api - The API client.
 * @param robotId - Robot whose lock is requested.
 * @param commandId - Identifier minted by the caller for this request.
 * @returns The validated lock answer.
 * @throws {ApiError} On any failure, including 409 when another operator holds the lock.
 */
export function postLock(
  api: ApiClient,
  robotId: RobotId,
  commandId: string,
): Promise<LockActionResponse> {
  return api.post(
    controlPaths.lock(DEMO_SITE_ID, robotId),
    { commandId },
    LockActionResponseSchema,
  );
}

/**
 * Releases the lock of a robot held by the caller.
 *
 * @param api - The API client.
 * @param robotId - Robot whose lock is released.
 * @param commandId - Identifier minted by the caller for this request.
 * @returns The validated lock answer.
 * @throws {ApiError} On any failure, including 409 when the caller does not hold the lock.
 */
export function postLockRelease(
  api: ApiClient,
  robotId: RobotId,
  commandId: string,
): Promise<LockActionResponse> {
  return api.post(
    controlPaths.lockRelease(DEMO_SITE_ID, robotId),
    { commandId },
    LockActionResponseSchema,
  );
}

/**
 * Query key of the lock state of one robot.
 *
 * @param robotId - Robot identifier.
 * @returns The key `[control-lock, robotId]`.
 */
export const lockKey = (robotId: RobotId): readonly unknown[] => [LOCK_KEY, robotId];

/**
 * Lists the robots of the demo site from the registry.
 *
 * @returns The registry entries, refetched every minute.
 */
export function useRobotRegistry(): UseQueryResult<RobotSummary[]> {
  const { api } = useServices();
  return useQuery({
    queryKey: [ROBOTS_KEY, DEMO_SITE_ID],
    queryFn: async () => {
      const response = await api.get(controlPaths.robots(DEMO_SITE_ID), RobotListResponseSchema);
      return response.robots;
    },
    refetchInterval: REGISTRY_REFETCH_MS,
  });
}

/**
 * Reads the lock state of one robot. The result also seeds the lock store, so the lock line is right before
 * the first frame arrives.
 *
 * @param robotId - Robot identifier.
 * @returns The lock state query.
 */
export function useLockState(robotId: RobotId): UseQueryResult<LockState> {
  const { api } = useServices();
  return useQuery({
    queryKey: lockKey(robotId),
    queryFn: () => api.get(controlPaths.lock(DEMO_SITE_ID, robotId), LockStateSchema),
  });
}

/**
 * Reads the demo mode of the site. Every role may read it, because the banner depends on it.
 *
 * @returns The demo state, refetched every 15 seconds.
 */
export function useDemoState(): UseQueryResult<DemoState> {
  const { api } = useServices();
  return useQuery({
    queryKey: [DEMO_KEY, DEMO_SITE_ID],
    queryFn: () => api.get(controlPaths.demo(DEMO_SITE_ID), DemoStateSchema),
    refetchInterval: DEMO_REFETCH_MS,
  });
}

/**
 * Switches the demo mode of the site. Only an Admin may call it; the API refuses everyone else.
 *
 * @returns The mutation, taking the new value of `enabled`. The answer replaces the cached demo state.
 */
export function useSetDemo(): UseMutationResult<DemoState, Error, boolean> {
  const { api } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put(controlPaths.demo(DEMO_SITE_ID), { enabled }, DemoStateSchema),
    onSuccess: (state) => {
      queryClient.setQueryData([DEMO_KEY, DEMO_SITE_ID], state);
    },
  });
}
