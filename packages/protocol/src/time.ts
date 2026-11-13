/**
 * Date and time schemas of the protocol.
 *
 * Only the forms that sort and compare correctly as strings are accepted, so that a consumer never
 * has to guess a timezone or a precision.
 */
import { z } from "zod";

/**
 * ISO 8601 UTC timestamp with millisecond precision and the `Z` suffix only.
 * The fixed shape keeps message ordering and replay windows unambiguous across languages.
 */
export const IsoMsSchema = z.iso.datetime({ precision: 3 });

/** A validated millisecond UTC timestamp. */
export type IsoMs = z.infer<typeof IsoMsSchema>;

/** ISO 8601 calendar date (`YYYY-MM-DD`), used for dates without a time of day such as a design date. */
export const IsoDateSchema = z.iso.date();

/** A validated calendar date. */
export type IsoDate = z.infer<typeof IsoDateSchema>;
