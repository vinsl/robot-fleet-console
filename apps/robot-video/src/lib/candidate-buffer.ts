/**
 * Buffer of the remote ICE candidates of each viewer, until its remote description is applied.
 *
 * A candidate can arrive before the offer it belongs to has been processed, and a browser refuses
 * a candidate while it has no remote description. The master therefore keeps the candidates of a
 * viewer aside and applies them, in arrival order, once the offer is set. The buffer is bounded per
 * viewer, so a flood of candidates cannot grow it without limit.
 */

/** Candidates kept per viewer while its offer is being processed. Real offers send far fewer. */
export const MAX_BUFFERED_CANDIDATES = 64;

/**
 * Keeps the candidates of each viewer until its remote description is applied.
 *
 * The type parameter is the candidate type, so that the buffer has no dependency on the DOM and is
 * tested with plain values.
 */
export class CandidateBuffer<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly applied = new Set<string>();

  /**
   * Receives a candidate. Returns true when it must be applied now, because the viewer's remote
   * description is already set. Otherwise the candidate is kept for {@link remoteDescriptionApplied}.
   *
   * A candidate beyond the bound is dropped: the viewer's connection can still succeed with the
   * candidates it has, and the bound keeps a misbehaving sender from using memory.
   *
   * @param clientId - The viewer's id.
   * @param candidate - The candidate.
   * @returns True when the caller applies the candidate now.
   */
  receive(clientId: string, candidate: T): boolean {
    if (this.applied.has(clientId)) {
      return true;
    }
    const queue = this.pending.get(clientId) ?? [];
    if (queue.length < MAX_BUFFERED_CANDIDATES) {
      queue.push(candidate);
      this.pending.set(clientId, queue);
    }
    return false;
  }

  /**
   * Records that the viewer's remote description is set, and returns the candidates that were kept,
   * in arrival order. The caller applies them, and later candidates are applied as they arrive.
   *
   * @param clientId - The viewer's id.
   * @returns The kept candidates. Empty when none arrived before the offer.
   */
  remoteDescriptionApplied(clientId: string): readonly T[] {
    this.applied.add(clientId);
    const queue = this.pending.get(clientId) ?? [];
    this.pending.delete(clientId);
    return queue;
  }

  /**
   * Forgets a viewer: its kept candidates and its applied flag. The next offer starts from nothing.
   *
   * @param clientId - The viewer's id.
   */
  forget(clientId: string): void {
    this.pending.delete(clientId);
    this.applied.delete(clientId);
  }

  /**
   * Forgets every viewer, when the run stops.
   */
  clear(): void {
    this.pending.clear();
    this.applied.clear();
  }
}
