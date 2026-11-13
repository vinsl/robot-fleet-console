/**
 * The command log of the robot panel: the last commands sent to the robot, newest first, with the robot's answer.
 *
 * Each line names the command, the latency of the answer or the reason of a refusal, and shows an icon from
 * `COMMAND_VISUALS`. The list is a polite live region, so a screen reader announces the answers as they arrive.
 * The text of a refusal is translated here: the robot's reason codes are not shown to the operator.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ACK_TEXT_KEYS, ackReasonKey, commandLabelKey, entryVisual } from "../control/ack-text";
import type { CommandEntry } from "../control/command-store";
import { classNames } from "../lib/class-names";
import { COMMAND_VISUALS } from "../theme/robot-state-visuals";
import styles from "./CommandLog.module.css";

/** How many commands the panel shows. The store keeps more, for the round trip of the last acknowledged one. */
export const COMMAND_LOG_VISIBLE = 8;

/**
 * The visual of a log line. Written as a switch over the closed visual keys, so each one is a typed table entry and
 * no lookup is made with a computed key.
 *
 * @param entry - The command entry.
 * @returns The entry of `COMMAND_VISUALS` for the line.
 */
function visualOf(entry: CommandEntry): (typeof COMMAND_VISUALS)[keyof typeof COMMAND_VISUALS] {
  switch (entryVisual(entry)) {
    case "pending":
      return COMMAND_VISUALS.pending;
    case "ack":
      return COMMAND_VISUALS.ack;
    case "reject":
      return COMMAND_VISUALS.reject;
  }
}

/**
 * The sentence of one log line, in the current language.
 *
 * @param entry - The command entry.
 * @param t - Translation function of the `robot` namespace, which the `states` sentences use too.
 * @returns The translated line.
 */
export function describeEntry(entry: CommandEntry, t: TFunction): string {
  const command = t(commandLabelKey(entry.type), { ns: "robot" });
  switch (entry.status) {
    case "pending":
      return t(COMMAND_VISUALS.pending.labelKey, { ns: "states", command });
    case "ack":
      return t(COMMAND_VISUALS.ack.labelKey, {
        ns: "states",
        command,
        latency: Math.round(entry.latencyMs ?? 0),
      });
    case "reject": {
      const reason =
        entry.reason === undefined
          ? t(ACK_TEXT_KEYS.failed, { ns: "robot" })
          : t(ackReasonKey(entry.reason, entry.type), { ns: "robot" });
      return t(COMMAND_VISUALS.reject.labelKey, { ns: "states", command, reason });
    }
    case "no-answer":
      return t(COMMAND_VISUALS.reject.labelKey, {
        ns: "states",
        command,
        reason: t(ACK_TEXT_KEYS.noAnswer, { ns: "robot" }),
      });
    case "failed":
      return t(COMMAND_VISUALS.reject.labelKey, {
        ns: "states",
        command,
        reason: t(ACK_TEXT_KEYS.failed, { ns: "robot" }),
      });
  }
}

/** Props of {@link CommandLog}. */
export interface CommandLogProps {
  /** The entries of the robot, newest first. */
  readonly entries: readonly CommandEntry[];
}

/**
 * Renders the most recent commands of the robot.
 *
 * @param props - The entries, newest first.
 * @returns The live list, or the empty sentence before the first command.
 */
export function CommandLog({ entries }: CommandLogProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const shown = entries.slice(0, COMMAND_LOG_VISIBLE);

  return (
    <div aria-live="polite">
      {shown.length === 0 ? (
        <p className={styles.empty}>{t("log.empty")}</p>
      ) : (
        <ol className={styles.list}>
          {shown.map((entry) => {
            const visual = visualOf(entry);
            const Icon = visual.icon;
            return (
              <li key={entry.commandId} className={styles.item} style={{ color: visual.color }}>
                <Icon
                  aria-hidden="true"
                  focusable="false"
                  className={classNames(styles.icon, entry.status === "pending" && styles.spinning)}
                />
                <span className={styles.text}>{describeEntry(entry, t)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
