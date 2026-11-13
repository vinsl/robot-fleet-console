/**
 * Deterministic ordering of the transition rows, shared by the generated JSON and the Markdown.
 *
 * The order is part of the contract: the Python mirror reads the same JSON, and a reviewer diffs the
 * Markdown. Sorting by plain code-unit comparison keeps the output the same on every machine.
 */
import type { CloudTransitionRow, TransitionRow } from "../src/index";

/**
 * Compares two strings by code unit, without locale rules.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns A negative number, zero or a positive number, as `Array.prototype.sort` expects.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Sorts robot rows by origin, trigger and guard.
 *
 * @param rows - The rows to sort. The input is not modified.
 * @returns A new array in table order.
 */
export function sortedRows(rows: readonly TransitionRow[]): TransitionRow[] {
  return [...rows].sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.trigger, right.trigger) ||
      compareText(left.guard, right.guard),
  );
}

/**
 * Sorts cloud rows by origin and trigger.
 *
 * @param rows - The rows to sort. The input is not modified.
 * @returns A new array in table order.
 */
export function sortedCloudRows(rows: readonly CloudTransitionRow[]): CloudTransitionRow[] {
  return [...rows].sort(
    (left, right) => compareText(left.from, right.from) || compareText(left.trigger, right.trigger),
  );
}
