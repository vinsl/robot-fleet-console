/**
 * Ordering of live robot samples by `(bootId, seq)`.
 *
 * A boot identifier is a UUIDv7, so a later boot compares greater as a string; the sequence number only
 * orders samples within one boot. Robot clocks are never compared, because the cloud does not trust them.
 * The rule is part of the wire contract (the API and the console must agree on what is newer), so it
 * lives here and nowhere else.
 */

/** The ordering key of a robot sample: boot (UUIDv7, string order = time order) then sequence. */
export interface SampleOrder {
  readonly bootId: string;
  readonly seq: number;
}

/**
 * Tells whether a sample is newer than the one already held.
 *
 * @param prev - The sample held, if any.
 * @param next - The candidate sample.
 * @returns `true` when there is no held sample, when the boot of `next` is greater, or when the boot is
 * the same and the sequence is greater. Equal keys are not newer.
 */
export function isNewerSample(prev: SampleOrder | undefined, next: SampleOrder): boolean {
  if (prev === undefined) {
    return true;
  }
  if (next.bootId !== prev.bootId) {
    return next.bootId > prev.bootId;
  }
  return next.seq > prev.seq;
}
