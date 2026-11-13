/**
 * Admission of viewers on the master page.
 *
 * The master holds one peer connection per viewer, so the number of viewers is bounded here
 * rather than left to the signaling service (FR-VID-2).
 */

/** Viewers one master serves at the same time. KVS itself allows more. */
export const MAX_VIEWERS = 3;

/** What the master does with an incoming offer. */
export type AdmissionDecision = "admit" | "replace" | "reject";

/** Client ids are chosen by the viewer page: letters, digits, `_`, `.` and `-`, up to 256 characters. */
const CLIENT_ID = /^[A-Za-z0-9_.-]{1,256}$/;

/**
 * Tells whether a client id is safe to use as a key and to send to the signaling service.
 *
 * @param clientId - The id announced in an offer.
 * @returns True when the id matches the accepted shape.
 */
export function isValidClientId(clientId: string): boolean {
  return CLIENT_ID.test(clientId);
}

/**
 * Decides what to do with an offer from a viewer.
 *
 * An offer from a viewer that already holds a slot replaces its old connection rather than
 * taking a new slot, so a viewer that reloads its page is not refused by its own ghost.
 *
 * @param connected - Client ids that currently hold a slot, connected or still being set up.
 * @param clientId - The id of the viewer that sent the offer.
 * @param max - Number of viewers allowed at once.
 * @returns `reject` for an invalid id or a full master, `replace` for a known id, else `admit`.
 */
export function admitViewer(
  connected: ReadonlySet<string>,
  clientId: string,
  max: number = MAX_VIEWERS,
): AdmissionDecision {
  if (!isValidClientId(clientId)) {
    return "reject";
  }
  if (connected.has(clientId)) {
    return "replace";
  }
  return connected.size >= max ? "reject" : "admit";
}

/**
 * Outcome of reserving a slot: a refusal, or the ticket that owns the slot until it is released.
 */
export type Reservation =
  | { readonly decision: "reject" }
  | { readonly decision: "admit" | "replace"; readonly ticket: symbol };

/**
 * The viewer slots of one master: one reservation per client id, taken by an offer before any
 * asynchronous work and kept until the offer fails, is replaced, or the run stops.
 *
 * Reservation is synchronous, so two offers that arrive together cannot both take the last slot.
 * A ticket is current only while it is the one recorded for its client id. A reservation that is
 * replaced or released makes its ticket stale, so the work that holds it must not touch the slot
 * or the peer connection that now belongs to a newer offer.
 */
export class ViewerSlots {
  private readonly tickets = new Map<string, symbol>();

  /**
   * @param max - Number of slots. Defaults to {@link MAX_VIEWERS}.
   */
  constructor(private readonly max: number = MAX_VIEWERS) {}

  /**
   * Number of slots taken, pending or connected. This is the count shown to the operator.
   *
   * @returns The number of client ids that hold a slot.
   */
  get size(): number {
    return this.tickets.size;
  }

  /**
   * Tells whether a client id holds a slot.
   *
   * @param clientId - The viewer's id.
   * @returns True while the id holds a slot.
   */
  has(clientId: string): boolean {
    return this.tickets.has(clientId);
  }

  /**
   * Reserves a slot for an offer, or replaces the reservation of the same viewer.
   *
   * A replacement keeps the slot and issues a new ticket, which makes the previous one stale. The
   * caller closes the previous peer connection of that viewer, if it has one.
   *
   * @param clientId - The viewer's id.
   * @returns `reject` with no ticket, or the decision and the ticket of this reservation.
   */
  reserve(clientId: string): Reservation {
    const decision = admitViewer(new Set(this.tickets.keys()), clientId, this.max);
    if (decision === "reject") {
      return { decision };
    }
    const ticket = Symbol(clientId);
    this.tickets.set(clientId, ticket);
    return { decision, ticket };
  }

  /**
   * Tells whether a ticket is the current reservation of its viewer.
   *
   * @param clientId - The viewer's id.
   * @param ticket - The ticket returned by {@link reserve}.
   * @returns True when no newer offer has replaced or released the reservation.
   */
  isCurrent(clientId: string, ticket: symbol): boolean {
    return this.tickets.get(clientId) === ticket;
  }

  /**
   * Releases a slot, only if the ticket is still the current reservation of its viewer.
   *
   * @param clientId - The viewer's id.
   * @param ticket - The ticket of the reservation to release.
   * @returns True when the slot was released; false when the ticket was stale and nothing changed.
   */
  release(clientId: string, ticket: symbol): boolean {
    if (!this.isCurrent(clientId, ticket)) {
      return false;
    }
    this.tickets.delete(clientId);
    return true;
  }

  /**
   * Releases every slot, when the run stops. Every ticket becomes stale.
   */
  clear(): void {
    this.tickets.clear();
  }
}
