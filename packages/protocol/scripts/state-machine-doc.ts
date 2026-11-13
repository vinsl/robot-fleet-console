/**
 * Renders `docs/STATE_MACHINE.md` from the transition table: a Mermaid diagram for the reader, and the
 * full rows for the reviewer who checks a change to the safety rules.
 *
 * The output is padded the way Prettier pads Markdown tables, so the committed file passes
 * `prettier --check` byte for byte.
 */
import { CLOUD_TRANSITIONS, TRANSITIONS, type TransitionRow } from "../src/index";
import { sortedCloudRows, sortedRows } from "./state-machine-rows";

/** Minimum width of a table column, as Prettier writes it (`---` is the shortest separator it keeps). */
const MIN_COLUMN_WIDTH = 3;

/**
 * Renders a Markdown table with every column padded to its widest cell.
 *
 * @param headers - Header cells.
 * @param rows - Body rows; each has one cell per header.
 * @returns The table, one line per row, without a trailing newline.
 */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(MIN_COLUMN_WIDTH, header.length, ...rows.map((row) => (row.at(column) ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths.at(column) ?? 0)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(headers), separator, ...rows.map(line)].join("\n");
}

/**
 * Label of a robot row in the diagram: its triggers and, when conditional, its guard. Colons are
 * replaced because Mermaid reads the first colon of an edge as the start of its label.
 *
 * @param row - The row to label.
 * @returns A short label such as `SIMULATE FAULT OBSTACLE` or `BOOT [LATCH_SET]`.
 */
function edgeText(row: TransitionRow): string {
  const trigger = row.trigger.replace(":", " ");
  return row.guard === "ALWAYS" ? trigger : `${trigger} [${row.guard}]`;
}

/**
 * Builds the Mermaid `stateDiagram-v2` body. Rows that keep the state (`SAME`) are left out of the
 * diagram; they remain in the table. Edges between the same two states are merged into one label.
 *
 * @returns The diagram source, without its code fence.
 */
export function buildDiagram(): string {
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string, label: string): void => {
    const key = `${from} --> ${to}`;
    const labels = edges.get(key) ?? [];
    if (!labels.includes(label)) {
      labels.push(label);
    }
    edges.set(key, labels);
  };

  for (const row of sortedRows(TRANSITIONS)) {
    if (row.to === "SAME") {
      continue;
    }
    const from = row.from === "START" ? "[*]" : row.from;
    addEdge(from, row.to, edgeText(row));
  }
  for (const row of sortedCloudRows(CLOUD_TRANSITIONS)) {
    addEdge(row.from, row.to, row.trigger);
  }

  const lines = ["stateDiagram-v2"];
  for (const [key, labels] of edges) {
    lines.push(`  ${key} : ${labels.join(" / ")}`);
  }
  return lines.join("\n");
}

/**
 * Renders the complete `docs/STATE_MACHINE.md` document.
 *
 * @returns The Markdown source, ending with a newline.
 */
export function buildStateMachineDoc(): string {
  const robotRows = sortedRows(TRANSITIONS).map((row) => [
    row.from,
    row.trigger,
    row.guard,
    row.to,
    row.effects.length === 0 ? "none" : row.effects.join(", "),
    row.reply,
    row.reason ?? "",
  ]);
  const cloudRows = sortedCloudRows(CLOUD_TRANSITIONS).map((row) => [
    row.from,
    row.trigger,
    row.to,
  ]);

  return [
    "# Robot state machine",
    "",
    "<!-- Generated from packages/protocol/src/state-machine.ts by `pnpm --filter @mfc/protocol generate`. Do not edit. -->",
    "",
    "The robot rows below are the table the robot agent runs (`agent/src/fleet_agent/core/state_machine.py`);",
    "a parity test compares the two row for row. `ESTOP` is reachable from every state and left only by",
    "`ESTOP_RELEASE`.",
    "The cloud marks a robot `OFFLINE`; the robot never reports that state itself.",
    "",
    "## Diagram",
    "",
    "Rows that keep the state (`SAME`) are omitted here; the tables below list every row.",
    "",
    "```mermaid",
    buildDiagram(),
    "```",
    "",
    "## Robot rows",
    "",
    "`reply` is `ACK` for an accepted command (a no-op is an `ACK` with `changed` false), `REJECT` with a",
    "reason, or `NONE` for internal triggers and `HEARTBEAT`. `START` is the origin of the boot rows only.",
    "`RESUME_TARGET` is a placeholder for the state the robot stored before pausing; `SAME` keeps the state.",
    "",
    markdownTable(["From", "Trigger", "Guard", "To", "Effects", "Reply", "Reason"], robotRows),
    "",
    "## Cloud rows",
    "",
    "`REPORTED` is a placeholder for the state the robot reports; the cloud resolves it from the message.",
    "",
    markdownTable(["From", "Trigger", "To"], cloudRows),
    "",
  ].join("\n");
}
