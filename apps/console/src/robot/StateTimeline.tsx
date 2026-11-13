/**
 * The state history of the robot panel: each state the robot went through in the last ten minutes, with the time it
 * was seen. The history is built from the states this session received (see `timeline.ts`).
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RobotState } from "@mfc/protocol";
import { StateChip } from "../components/StateChip";
import { appendState, type TimelineEntry } from "./timeline";
import styles from "./StateTimeline.module.css";

/** Props of {@link StateTimeline}. */
export interface StateTimelineProps {
  /** The state the panel shows now. Each change is recorded once. */
  readonly state: RobotState;
}

/**
 * Renders the history. The first render records the current state, so the list is never empty.
 *
 * @param props - The current state.
 * @returns The list.
 */
export function StateTimeline({ state }: StateTimelineProps): React.JSX.Element {
  const { i18n } = useTranslation("robot");
  const [timeline, setTimeline] = useState<readonly TimelineEntry[]>(() =>
    appendState([], state, Date.now()),
  );

  // The effect runs after the state changes; `appendState` ignores a state that is already the last one, so the
  // effect running on mount or on a re-render with the same state adds nothing.
  useEffect(() => {
    setTimeline((previous) => appendState(previous, state, Date.now()));
  }, [state]);

  return (
    <ol className={styles.list}>
      {timeline.map((entry) => (
        <li key={String(entry.atMs) + ":" + entry.state} className={styles.item}>
          <StateChip state={entry.state} />
          <time dateTime={new Date(entry.atMs).toISOString()} className={styles.time}>
            {new Date(entry.atMs).toLocaleTimeString(i18n.language, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </li>
      ))}
    </ol>
  );
}
