/**
 * The robot lock as the panel uses it: who holds it, and the two actions to take or give it up.
 *
 * Taking the lock is two steps. The API answers once the cloud has written the lock and published `TAKE_CONTROL`;
 * the robot's own answer (`command.ack`) comes later on the socket. A `REJECT NOT_LOCK_HOLDER` is the one answer
 * that is retried, once, after {@link LOCK_RETRY_DELAY_MS} and with a new identifier (ADR 0066). The cloud does
 * not retry, because the robot's answer is seen only here.
 */
import { useCallback, useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  COMMAND_ACK_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  uuidv7,
  type LockActionResponse,
  type LockState,
  type RobotId,
} from "@mfc/protocol";
import { lockKey, postLock, postLockRelease, useLockState } from "../api/control";
import type { ApiClient } from "../api/http-client";
import { useServices } from "../app/services";
import { useAuthStore } from "../auth/auth-store";
import { useCommandStore, type CommandEntry, type CommandStatus } from "./command-store";
import { failCommand } from "./use-command";
import { holderLabel, isLockMine, useLockStore } from "./lock-store";

/** Who holds the lock, from the console's point of view. `unknown` until the first answer or frame. */
export type ControlState = "free" | "mine" | "other" | "unknown";

/** The lock of one robot and the actions on it. */
export interface ControlLock {
  /** Who holds the lock. */
  readonly state: ControlState;
  /** Name of the holder when another operator holds the lock. */
  readonly holderLabel?: string | undefined;
  /**
   * Takes the lock and waits for the robot's answer to the take, which is the signal that the robot accepted it.
   *
   * @returns The final status of the take: `ack`, `reject`, `no-answer` or `failed`.
   */
  readonly acquire: () => Promise<CommandStatus>;
  /** Gives the lock up. The robot's answer arrives later on the socket. */
  readonly release: () => Promise<void>;
  /** `true` while an acquire or a release request is running. */
  readonly busy: boolean;
}

/**
 * Resolves after a delay.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that resolves when the delay has passed.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits until the robot answers a command, or until the acknowledgement timeout passes.
 *
 * @param commandId - The command to wait for.
 * @returns The settled entry, or `undefined` when the entry is no longer tracked.
 */
function waitForAnswer(commandId: string): Promise<CommandEntry | undefined> {
  return new Promise((resolve) => {
    const current = (): CommandEntry | undefined =>
      useCommandStore.getState().entries.get(commandId);
    const settled = (entry: CommandEntry | undefined): boolean =>
      entry === undefined || entry.status !== "pending";

    const initial = current();
    if (settled(initial)) {
      resolve(initial);
      return;
    }

    const finish = (entry: CommandEntry | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(entry);
    };
    const unsubscribe = useCommandStore.subscribe(() => {
      const entry = current();
      if (settled(entry)) {
        finish(entry);
      }
    });
    const timer = setTimeout(() => {
      // Expire from the command's own send time, so the outcome does not depend on the clock that fired the timer.
      const entry = current();
      if (entry !== undefined) {
        useCommandStore.getState().expire(entry.sentAt + COMMAND_ACK_TIMEOUT_MS);
      }
      finish(current());
    }, COMMAND_ACK_TIMEOUT_MS);
  });
}

/**
 * Records a lock answer of the API in the store and in the query cache. The cache entry is what a remount reads
 * first, so it must hold the answer too: otherwise a remount would show the state from before the take.
 *
 * @param queryClient - The query cache.
 * @param robotId - The robot.
 * @param lock - The lock state the API answered.
 */
function recordLockAnswer(queryClient: QueryClient, robotId: RobotId, lock: LockState): void {
  useLockStore.getState().applyState(robotId, lock);
  queryClient.setQueryData<LockState>(lockKey(robotId), lock);
}

/**
 * One take of the lock. The retry on `NOT_LOCK_HOLDER` is decided here, because only here the robot's answer is known.
 *
 * @param api - The API client.
 * @param queryClient - The query cache, to refetch the lock after a conflict.
 * @param robotId - The robot.
 * @param attempt - 1 for the first take, 2 for the single retry.
 * @returns The final status of this take, after any retry.
 */
async function takeLock(
  api: ApiClient,
  queryClient: QueryClient,
  robotId: RobotId,
  attempt: 1 | 2,
): Promise<CommandStatus> {
  const commandId = uuidv7();
  useCommandStore.getState().begin({
    commandId,
    robotId,
    type: "TAKE_CONTROL",
    sentAt: performance.now(),
  });
  let response: LockActionResponse;
  try {
    response = await postLock(api, robotId, commandId);
  } catch (error) {
    failCommand(commandId, robotId, error, queryClient);
    return "failed";
  }
  recordLockAnswer(queryClient, robotId, response.lock);

  const answer = await waitForAnswer(commandId);
  if (answer?.status === "reject" && answer.reason === "NOT_LOCK_HOLDER" && attempt === 1) {
    await delay(LOCK_RETRY_DELAY_MS);
    return takeLock(api, queryClient, robotId, 2);
  }
  return answer?.status ?? "no-answer";
}

/**
 * Returns the lock of one robot for the signed-in user, and the actions on it.
 *
 * @param robotId - The robot the panel shows.
 * @returns The lock state and actions.
 */
export function useControlLock(robotId: RobotId): ControlLock {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const { t } = useTranslation("robot");
  const userId = useAuthStore((state) => state.userId);
  const entry = useLockStore((state) => state.locks.get(robotId));
  const [busy, setBusy] = useState(false);

  // The first read of the API seeds the store, so the lock line is right before the first frame arrives. It only
  // seeds: a read that resolves after a take, or after a frame, is older than what the store already knows.
  const lockQuery = useLockState(robotId);
  const seeded = lockQuery.data;
  useEffect(() => {
    if (seeded !== undefined) {
      useLockStore.getState().seedLock(robotId, seeded);
    }
  }, [seeded, robotId]);

  const acquire = useCallback(async (): Promise<CommandStatus> => {
    setBusy(true);
    try {
      return await takeLock(api, queryClient, robotId, 1);
    } finally {
      setBusy(false);
    }
  }, [api, queryClient, robotId]);

  const release = useCallback(async (): Promise<void> => {
    const commandId = uuidv7();
    useCommandStore.getState().begin({
      commandId,
      robotId,
      type: "RELEASE_CONTROL",
      sentAt: performance.now(),
    });
    setBusy(true);
    try {
      const response = await postLockRelease(api, robotId, commandId);
      recordLockAnswer(queryClient, robotId, response.lock);
    } catch (error) {
      failCommand(commandId, robotId, error, queryClient);
    } finally {
      setBusy(false);
    }
  }, [api, queryClient, robotId]);

  let state: ControlState = "unknown";
  if (entry !== undefined) {
    if (!entry.held) {
      state = "free";
    } else {
      state = isLockMine(entry, userId) ? "mine" : "other";
    }
  }
  const label =
    entry?.held === true && entry.holder !== undefined ? holderLabel(entry.holder, t) : undefined;

  return { state, holderLabel: label, acquire, release, busy };
}
