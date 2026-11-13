/**
 * The robot panel, top to bottom as DESIGN 2.2: video, identifier and state, readouts, lock line, command log,
 * state history, command grid, fault injector (simulated robots only) and the e-stop last.
 *
 * The panel owns the lifecycle that depends on the lock: heartbeats run only while this user holds the lock, the
 * lock is given up after 30 minutes without input, and the command clock expires unanswered commands. Which
 * controls appear is decided once, by `robotVisibility`, so a Viewer gets the lock line and nothing else.
 */
import type * as React from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { RobotId } from "@mfc/protocol";
import { useSendCommand } from "../control/use-command";
import { useCommandExpiry } from "../control/use-command-clock";
import { useHeartbeat } from "../control/use-heartbeat";
import { useIdleRelease } from "../control/use-idle-release";
import { StateChip } from "../components/StateChip";
import { Collapsible } from "./Collapsible";
import { CommandLog } from "./CommandLog";
import { CommandPanel } from "./CommandPanel";
import { EStopButton } from "./EStopButton";
import { FaultInjector } from "./FaultInjector";
import { LockLine } from "./LockLine";
import { Readouts } from "./Readouts";
import { StateTimeline } from "./StateTimeline";
import { VideoSlot } from "./VideoSlot";
import { useRobotContext } from "./use-robot-context";
import styles from "./RobotPanel.module.css";

/** Props of {@link RobotPanel}. */
export interface RobotPanelProps {
  /** The robot the panel shows. The route has validated it. */
  readonly robotId: RobotId;
}

/**
 * Renders the panel of one robot.
 *
 * @param props - The robot identifier.
 * @returns The panel content, to be placed inside the side panel.
 */
export function RobotPanel({ robotId }: RobotPanelProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const context = useRobotContext(robotId);
  const { view, summary, visibility, socketOpen, entries, lastRoundTripMs, lock } = context;
  const { send } = useSendCommand(robotId);
  const heartbeat = useHeartbeat(robotId, lock.state === "mine");
  const holdsLock = lock.state === "mine";

  const { release } = lock;
  const releaseOnIdle = useCallback(() => release(), [release]);
  useIdleRelease(holdsLock, releaseOnIdle);
  useCommandExpiry();

  return (
    <div className={styles.panel}>
      <VideoSlot
        robotId={robotId}
        simulated={summary?.simulated}
        overlay={{
          name: summary?.name,
          state: view?.displayState,
          pose: context.robot?.pose ?? null,
        }}
      />
      <div className={styles.header}>
        <h3 className={styles.id}>{robotId}</h3>
        {view === undefined ? null : <StateChip state={view.displayState} />}
      </div>
      {view === undefined ? <p className={styles.muted}>{t("panel.noData")}</p> : null}
      <Readouts robot={context.robot} name={summary?.name} lastRoundTripMs={lastRoundTripMs} />
      <LockLine
        lock={lock}
        canTake={visibility.canCommand}
        socketOpen={socketOpen}
        linkOk={heartbeat.linkOk}
      />
      {visibility.canCommand ? (
        <Collapsible title={t("panel.log")}>
          <CommandLog entries={entries} />
        </Collapsible>
      ) : null}
      {view === undefined ? null : (
        <Collapsible title={t("panel.timeline")}>
          <StateTimeline key={robotId} state={view.displayState} />
        </Collapsible>
      )}
      {visibility.canCommand ? (
        <CommandPanel lock={lock} socketOpen={socketOpen} send={send} />
      ) : null}
      {visibility.canInjectFault ? <FaultInjector disabled={!socketOpen} send={send} /> : null}
      {visibility.canEstop ? (
        <EStopButton
          displayState={view?.displayState}
          socketOpen={socketOpen}
          lock={lock}
          send={send}
        />
      ) : null}
    </div>
  );
}
