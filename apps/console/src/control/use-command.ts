/**
 * Sending one controlled command from the robot panel.
 *
 * Every press and every retry mints a new `commandId` (UUIDv7) before the request leaves. A crash or a lost
 * response can leave a claim behind on the cloud for an hour (R92), so reusing an identifier would turn a
 * second press into a silent deduplication. Nothing here waits for another request: the e-stop is sent at once,
 * and a command is never queued behind a previous one.
 */
import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { uuidv7, type CommandRequest, type LockState, type RobotId } from "@mfc/protocol";
import { lockKey, postCommand } from "../api/control";
import { ApiError } from "../api/http-client";
import { useServices } from "../app/services";
import { useCommandStore } from "./command-store";
import { useLockStore } from "./lock-store";

/** Distributes `Omit` over the members of a union, so that each command keeps its own parameters. */
type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;

/** A command as the caller states it. The identifier is minted by the send, never by the caller. */
export type CommandDraft = WithoutCommandId<CommandRequest>;

/** The operation a panel button runs. */
export interface SendCommand {
  /**
   * Sends one command to the robot. Resolves when the API has answered or failed; the robot's answer arrives later
   * as a frame and lands in the command store. Never rejects.
   *
   * @param draft - The command, without its identifier.
   */
  readonly send: (draft: CommandDraft) => Promise<void>;
}

/**
 * Reads the lock again after a conflict and applies the fresh answer to the store. The store must be written
 * here, not by the seeding effect: a seed never overwrites an entry, and the conflict is the case where the
 * entry is stale.
 *
 * @param robotId - The robot.
 * @param queryClient - The query cache.
 */
async function refreshLock(robotId: RobotId, queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: lockKey(robotId) });
  const lock = queryClient.getQueryData<LockState>(lockKey(robotId));
  if (lock !== undefined) {
    useLockStore.getState().applyState(robotId, lock);
  }
}

/**
 * Records a request that got no answer. A conflict (409) means the lock state the console shows may be stale, so
 * the lock is read again.
 *
 * @param commandId - The command whose request failed.
 * @param robotId - The robot of the command.
 * @param error - What the request threw.
 * @param queryClient - The query cache, to refetch the lock.
 */
export function failCommand(
  commandId: string,
  robotId: RobotId,
  error: unknown,
  queryClient: QueryClient,
): void {
  useCommandStore.getState().fail(commandId);
  if (error instanceof ApiError && error.status === 409) {
    void refreshLock(robotId, queryClient);
  }
}

/**
 * Returns the send operation of one robot.
 *
 * @param robotId - The robot the panel shows.
 * @returns The operation.
 */
export function useSendCommand(robotId: RobotId): SendCommand {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const send = useCallback(
    async (draft: CommandDraft): Promise<void> => {
      const commandId = uuidv7();
      useCommandStore.getState().begin({
        commandId,
        robotId,
        type: draft.type,
        sentAt: performance.now(),
      });
      try {
        await postCommand(api, robotId, { ...draft, commandId });
      } catch (error) {
        failCommand(commandId, robotId, error, queryClient);
      }
    },
    [api, queryClient, robotId],
  );
  return { send };
}
