/**
 * Ordering of live robot samples by `(bootId, seq)`.
 *
 * The rule itself lives in `@mfc/protocol` (`isNewerSample`), because the console applies the same rule
 * to the frames it receives. This module keeps the batch helper that only the API needs.
 */
import { isNewerSample, type SampleOrder } from "@mfc/protocol";

/** The ordering key of a sample. */
export type Ordered = SampleOrder;

/**
 * Tells whether a sample is newer than the one already held.
 *
 * @param prev - The sample held, if any.
 * @param next - The candidate sample.
 * @returns `true` when there is no held sample, when the boot of `next` is greater, or when the boot is
 * the same and the sequence is greater. Equal keys are not newer.
 */
export function isNewer(prev: Ordered | undefined, next: Ordered): boolean {
  return isNewerSample(prev, next);
}

/**
 * Keeps the newest sample of each robot in a batch.
 *
 * @param items - Samples of any robots, in any order.
 * @returns The newest sample per robot, and how many samples were superseded by a newer one.
 */
export function latestPerRobot<T extends Ordered & { readonly robotId: string }>(
  items: readonly T[],
): { latest: Map<string, T>; superseded: number } {
  const latest = new Map<string, T>();
  for (const item of items) {
    if (isNewer(latest.get(item.robotId), item)) {
      latest.set(item.robotId, item);
    }
  }
  return { latest, superseded: items.length - latest.size };
}
