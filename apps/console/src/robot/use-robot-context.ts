/**
 * Everything the robot panel knows about one robot, combined in one place: the registry entry, the live fleet view,
 * the role, the demo mode, the command log and the lock. The visibility rules are pure functions of these inputs,
 * so the table of who may see what is tested without rendering anything (ADR 0066).
 *
 * The rules only shape the UI. The API checks the role, the lock and the demo mode again on every request.
 */
import { useMemo } from "react";
import type { Role, RobotSummary, RobotId } from "@mfc/protocol";
import { useDemoState, useRobotRegistry } from "../api/control";
import { useAuthStore } from "../auth/auth-store";
import { useControlLock, type ControlLock } from "../control/use-control-lock";
import { useCommandStore, type CommandBook, type CommandEntry } from "../control/command-store";
import type { LiveRobot } from "../live/fleet-reducer";
import { robotView, type RobotView } from "../live/fleet-selectors";
import { useFleetStore } from "../live/fleet-store";
import { useNow } from "../live/use-now";
import { useWsStore } from "../ws/ws-store";
import { live } from "../theme/tokens";

/** What the signed-in user may see and do on a robot panel. */
export interface RobotVisibility {
  /** Commands and the lock actions are shown. Only Admin and Operator send commands; a Viewer sees the lock line only. */
  readonly canCommand: boolean;
  /** The e-stop is shown and enabled. Same roles as commands, and never behind a lock (FR-CMD-4). */
  readonly canEstop: boolean;
  /** The fault injector is shown: Admin only, demo mode on, and a robot that is simulated. */
  readonly canInjectFault: boolean;
}

/** Inputs of the visibility rules. */
export interface VisibilityInput {
  readonly role: Role | null;
  readonly demoEnabled: boolean;
  /** `undefined` while the registry has not answered; the fault injector stays hidden then. */
  readonly simulated: boolean | undefined;
}

/**
 * Decides what the panel shows. Pure, so the table of roles is tested row by row.
 *
 * @param input - The role, the demo mode and whether the robot is simulated.
 * @returns The visibility of each control group.
 */
export function robotVisibility(input: VisibilityInput): RobotVisibility {
  const operates = input.role === "Admin" || input.role === "Operator";
  return {
    canCommand: operates,
    canEstop: operates,
    canInjectFault: input.role === "Admin" && input.demoEnabled && input.simulated === true,
  };
}

/** The command log of one robot, newest first. */
export function recentEntries(book: CommandBook, robotId: RobotId): readonly CommandEntry[] {
  const ids = book.logByRobot.get(robotId) ?? [];
  const entries: CommandEntry[] = [];
  for (const id of ids) {
    const entry = book.entries.get(id);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries.reverse();
}

/**
 * The round trip of the most recent acknowledged command, in milliseconds.
 *
 * @param entries - The command log, newest first.
 * @returns The latency, or `undefined` when no command was acknowledged yet.
 */
export function lastRoundTripMs(entries: readonly CommandEntry[]): number | undefined {
  return entries.find((entry) => entry.status === "ack" && entry.latencyMs !== undefined)
    ?.latencyMs;
}

/** Everything the panel reads about one robot. */
export interface RobotContext {
  /** The live view of the robot, or `undefined` before the first frame about it. */
  readonly view: RobotView | undefined;
  /** The live fleet record, or `undefined` before the first frame about it. */
  readonly robot: LiveRobot | undefined;
  /** The registry entry, or `undefined` while the registry is loading or the robot is unknown to it. */
  readonly summary: RobotSummary | undefined;
  /** Who may see what. */
  readonly visibility: RobotVisibility;
  /** Whether the realtime socket is open. Commands other than the e-stop wait for it. */
  readonly socketOpen: boolean;
  /** The command log of the robot, newest first. */
  readonly entries: readonly CommandEntry[];
  /** Round trip of the last acknowledged command, if any. */
  readonly lastRoundTripMs: number | undefined;
  /** The lock of the robot and the actions on it. */
  readonly lock: ControlLock;
}

/**
 * Combines the sources of the robot panel.
 *
 * @param robotId - The robot the panel shows.
 * @returns The context of the panel.
 */
export function useRobotContext(robotId: RobotId): RobotContext {
  const now = useNow(live.nowTickMs);
  const role = useAuthStore((state) => state.role);
  const socketOpen = useWsStore((state) => state.connection) === "open";
  // The robot identifier is validated by the route before this hook runs, and the own-property check keeps a
  // lookup from reaching the prototype chain.
  const robot = useFleetStore((state) =>
    Object.hasOwn(state.robots, robotId)
      ? // eslint-disable-next-line security/detect-object-injection -- own-property checked just above
        state.robots[robotId]
      : undefined,
  );
  const entriesById = useCommandStore((state) => state.entries);
  const logByRobot = useCommandStore((state) => state.logByRobot);
  const book: CommandBook = useMemo(
    () => ({ entries: entriesById, logByRobot }),
    [entriesById, logByRobot],
  );
  const registry = useRobotRegistry();
  const demo = useDemoState();
  const lock = useControlLock(robotId);

  const summary = registry.data?.find((entry) => entry.robotId === robotId);
  const entries = useMemo(() => recentEntries(book, robotId), [book, robotId]);
  const view = robot === undefined ? undefined : robotView(robot, now, socketOpen);
  const visibility = robotVisibility({
    role,
    demoEnabled: demo.data?.enabled === true,
    simulated: summary?.simulated,
  });

  return {
    view,
    robot,
    summary,
    visibility,
    socketOpen,
    entries,
    lastRoundTripMs: lastRoundTripMs(entries),
    lock,
  };
}
