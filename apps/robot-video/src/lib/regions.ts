/**
 * Regions the video page accepts.
 *
 * The demo region and its documented fallback (ADR 0006). The page refuses a session or an endpoint
 * from any other region, so a session cannot point it at a channel elsewhere. The list matches the
 * protocol's `AwsRegionSchema`, which the session schema already enforces.
 */

/** Regions accepted by the page, in order of preference. */
export const VIDEO_REGIONS = ["eu-west-3", "eu-west-1"] as const;

/** One of the regions listed in {@link VIDEO_REGIONS}. */
export type VideoRegion = (typeof VIDEO_REGIONS)[number];
