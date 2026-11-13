/**
 * Round-trip time of the media path, read from the browser's WebRTC statistics.
 *
 * The overlay shows one figure from the statistics, the round trip of the candidate pair that carries the media.
 * Only that figure and the pair's selection are read: addresses, ports and candidate details are never copied out
 * of the browser's objects, so nothing that identifies a network path reaches the screen or a log.
 */
import { z } from "zod";

/** The transport entry of a report, which names the selected candidate pair (Chromium). */
const TransportSchema = z.object({
  type: z.literal("transport"),
  selectedCandidatePairId: z.string().nullish(),
});

/** A candidate pair of a report. Zod strips every key that is not listed here. */
const CandidatePairSchema = z.object({
  type: z.literal("candidate-pair"),
  id: z.string(),
  state: z.string().nullish(),
  nominated: z.boolean().nullish(),
  selected: z.boolean().nullish(),
  currentRoundTripTime: z.number().nullish(),
});

/** Everything the selection needs, collected from one report. */
interface CollectedPairs {
  readonly selectedPairId: string | null;
  readonly pairs: ReadonlyMap<string, z.infer<typeof CandidatePairSchema>>;
}

/**
 * Reads the transport entry and the candidate pairs of a report. An entry that does not match its schema is
 * skipped, because browsers add entry types and fields over time.
 *
 * @param entries - The values of an `RTCStatsReport`.
 * @returns The selected pair id and the pairs by id.
 */
function collectPairs(entries: Iterable<unknown>): CollectedPairs {
  let selectedPairId: string | null = null;
  const pairs = new Map<string, z.infer<typeof CandidatePairSchema>>();
  for (const entry of entries) {
    const transport = TransportSchema.safeParse(entry);
    if (transport.success) {
      selectedPairId = transport.data.selectedCandidatePairId ?? selectedPairId;
      continue;
    }
    const pair = CandidatePairSchema.safeParse(entry);
    if (pair.success) {
      pairs.set(pair.data.id, pair.data);
    }
  }
  return { selectedPairId, pairs };
}

/**
 * Picks the candidate pair that carries the media. Three rules, in order: the transport's selected pair
 * (Chromium), a pair flagged `selected` (Firefox has no transport entry), then a nominated pair that succeeded.
 *
 * @param collected - The pairs of the report.
 * @returns The selected pair, or `undefined` when no rule matches.
 */
function selectPair(collected: CollectedPairs): z.infer<typeof CandidatePairSchema> | undefined {
  const transportPair =
    collected.selectedPairId === null ? undefined : collected.pairs.get(collected.selectedPairId);
  if (transportPair !== undefined) {
    return transportPair;
  }
  const pairs = [...collected.pairs.values()];
  return (
    pairs.find((pair) => pair.selected === true) ??
    pairs.find((pair) => pair.nominated === true && pair.state === "succeeded")
  );
}

/**
 * Round-trip time of the media path, in milliseconds.
 *
 * @param entries - The values of an `RTCStatsReport`, typically `report.values()`.
 * @returns The round trip, or `null` when the report has no selected pair or no measured round trip yet.
 */
export function roundTripMsFromReport(entries: Iterable<unknown>): number | null {
  const pair = selectPair(collectPairs(entries));
  const seconds = pair?.currentRoundTripTime;
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return seconds * 1000;
}
