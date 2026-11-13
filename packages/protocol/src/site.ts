/**
 * Site configuration contract: the site profile, the versions of its map and the presigned transfers of
 * the site API.
 *
 * A map version moves through two states. `PENDING` is a slot reserved for an upload that has not been
 * validated; `VALID` is a map whose stored object was read, parsed and pinned to one object version. Only
 * a `VALID` version can become the active map, so the planner never reads an upload it has not seen. The
 * summary of a version is derived from the map itself by {@link summarizeSiteMap}, so the console and the
 * API report the same numbers.
 */
import { z } from "zod";
import { ActorSchema, SiteIdSchema } from "./ids";
import { IsoMsSchema } from "./time";
import {
  SITE_MAP_MAX_BYTES,
  featurePositions,
  type SiteMap,
  type SiteMapFeatureKind,
} from "./site-map";

/** Largest number of map versions one site keeps. Reaching it refuses a new upload slot (`version-limit`). */
export const MAP_MAX_VERSIONS = 200;

/** Longest site name, in characters, after trimming. */
export const SITE_NAME_MAX = 64;

/** Media type of a site map object, set on the presigned upload and on the presigned download. */
export const SITE_MAP_CONTENT_TYPE = "application/geo+json";

/** Lifetime of a presigned upload, in seconds. Long enough for a slow link, short enough to be a poor credential. */
export const SITE_MAP_UPLOAD_TTL_S = 300;

/** Lifetime of a presigned download, in seconds. Kept apart from the upload lifetime so that either can change alone. */
export const SITE_MAP_DOWNLOAD_TTL_S = 300;

/** Largest number of fields of a presigned POST form. The form has a fixed, short set; more is refused. */
const MAX_UPLOAD_FIELDS = 20;

/** Largest value of one presigned POST field, in characters. Covers the policy and the signature with room. */
const MAX_UPLOAD_FIELD_VALUE_LENGTH = 8192;

/** Grammar of a presigned POST field name: the characters S3 accepts in a form, bounded in length. */
const UPLOAD_FIELD_KEY_PATTERN = /^[A-Za-z0-9_.$-]{1,64}$/;

/** Field names that would alter an object's prototype when a form is built from them. */
const FORBIDDEN_UPLOAD_FIELD_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Fields a presigned POST must carry: the object key, and the media type stored with it. */
const REQUIRED_UPLOAD_FIELDS = ["key", "Content-Type"] as const;

/** Host grammar of a presigned S3 URL: `<bucket>.s3.<region>.amazonaws.com`, lower case only. */
const S3_HOST_PATTERN = /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/;

/** Map version number: a positive integer below one million, so the six-digit storage key always fits. */
export const MapVersionNumberSchema = z.int().min(1).max(999_999);

/** A validated map version number. */
export type MapVersionNumber = z.infer<typeof MapVersionNumberSchema>;

/**
 * Version segment of a URL path: a decimal number without sign or leading zero, and without exponent.
 * The grammar is checked before the number is read, so `1e3`, `07` and `7/../` never reach the storage key.
 */
const MAP_VERSION_PARAM_PATTERN = /^[1-9][0-9]{0,5}$/;

/** Version segment of a URL path, converted to its number once it has passed the grammar. */
export const MapVersionParamSchema = z
  .string()
  .regex(MAP_VERSION_PARAM_PATTERN)
  .transform((value) => Number(value))
  .pipe(MapVersionNumberSchema);

/** Map reference of a URL path: a version number, or `active` for the map the site uses now. */
export const MapRefParamSchema = z.union([z.literal("active"), MapVersionParamSchema]);

/** A validated map reference. */
export type MapRef = z.infer<typeof MapRefParamSchema>;

/**
 * Site name shown to the operator. Trimmed, then bounded, and free of angle brackets and of the Unicode
 * control (`Cc`), format (`Cf`), line separator (`Zl`) and paragraph separator (`Zp`) categories. Those
 * categories cover the C0 and C1 ranges, the bidirectional overrides that could reverse the text on screen,
 * and the separators that break a line, so the name cannot carry markup, a visual spoof or a line break.
 */
export const SiteNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SITE_NAME_MAX)
  .regex(/^[^<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);

/** Site profile as the API returns it. Strict, so no field beyond the profile can reach the browser. */
export const SiteSchema = z.strictObject({
  siteId: SiteIdSchema,
  name: SiteNameSchema,
  activeVersion: MapVersionNumberSchema.nullable(),
  updatedAt: IsoMsSchema.nullable(),
});

/** A validated site profile. */
export type Site = z.infer<typeof SiteSchema>;

/** Body of `PUT /sites/{siteId}`. Only the name is writable; the strict object refuses any other field. */
export const UpdateSiteRequestSchema = z.strictObject({
  name: SiteNameSchema,
});

/** A validated site update request. */
export type UpdateSiteRequest = z.infer<typeof UpdateSiteRequestSchema>;

/** Status of a map version: reserved and not yet validated, or validated and pinned to an object version. */
export const MapStatusSchema = z.enum(["PENDING", "VALID"]);

/** A validated map status. */
export type MapStatus = z.infer<typeof MapStatusSchema>;

/** Count of one feature kind. Each kind is listed, so a missing kind is a zero, not an absent key. */
const KindCountsSchema = z.strictObject({
  wall: z.int().min(0),
  obstacle: z.int().min(0),
  charger: z.int().min(0),
  workstation: z.int().min(0),
  nogo: z.int().min(0),
});

/** Summary of a validated map: feature counts and the extent of its positions, in metres. */
export const MapSummarySchema = z.strictObject({
  counts: KindCountsSchema,
  extentM: z.strictObject({
    x: z.number().min(0),
    y: z.number().min(0),
  }),
});

/** A validated map summary. */
export type MapSummary = z.infer<typeof MapSummarySchema>;

/**
 * Summarises a validated site map: how many features of each kind, and how far the positions reach on
 * each axis. Pure, so the API stores the result and the console can compute the same numbers locally.
 *
 * @param map - A site map that has passed {@link SiteMapSchema}.
 * @returns The feature counts and the extent of the positions, in metres.
 */
export function summarizeSiteMap(map: SiteMap): MapSummary {
  const counts: Record<SiteMapFeatureKind, number> = {
    wall: 0,
    obstacle: 0,
    charger: 0,
    workstation: 0,
    nogo: 0,
  };
  for (const feature of map.features) {
    counts[feature.properties.kind] += 1;
  }

  const positions = map.features.flatMap(featurePositions);
  const first = positions[0];
  if (first === undefined) {
    return { counts, extentM: { x: 0, y: 0 } };
  }
  let minX = first[0];
  let maxX = first[0];
  let minY = first[1];
  let maxY = first[1];
  for (const [x, y] of positions) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { counts, extentM: { x: maxX - minX, y: maxY - minY } };
}

/**
 * One map version as the API lists it. The summary is present only once the version is `VALID`, and
 * `active` marks the version the site uses now.
 */
export const MapVersionSchema = z.strictObject({
  version: MapVersionNumberSchema,
  status: MapStatusSchema,
  createdAt: IsoMsSchema,
  createdBy: ActorSchema,
  sizeBytes: z.int().min(0).max(SITE_MAP_MAX_BYTES).nullable(),
  summary: MapSummarySchema.nullable(),
  active: z.boolean(),
});

/** A validated map version. */
export type MapVersion = z.infer<typeof MapVersionSchema>;

/** Response of `GET /sites/{siteId}/maps`: the versions, newest first. */
export const MapVersionsResponseSchema = z.strictObject({
  versions: z.array(MapVersionSchema).max(MAP_MAX_VERSIONS),
});

/** A validated list of map versions. */
export type MapVersionsResponse = z.infer<typeof MapVersionsResponseSchema>;

/**
 * Whether a text is a presigned S3 URL the console may open: HTTPS, an S3 host of the bucket grammar, and
 * no credentials, port or fragment. The authority is read from the raw text as well as through `URL`,
 * because `URL` drops a default port such as `:443`, and the rule is that no port is present at all.
 *
 * @param value - The URL text, as the API returned it.
 * @returns True when the text satisfies the presigned host rule.
 */
export function isSiteMapS3Url(value: string): boolean {
  const authority = /^https:\/\/([^/?#]*)/.exec(value)?.[1];
  if (
    authority === undefined ||
    authority.includes("@") ||
    authority.includes(":") ||
    authority !== authority.toLowerCase()
  ) {
    return false;
  }
  if (value.includes("#")) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    S3_HOST_PATTERN.test(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.port === ""
  );
}

/**
 * HTTPS URL of a presigned S3 request, checked by {@link isSiteMapS3Url}. The console opens only these
 * hosts, so a response that points elsewhere is refused by the contract.
 */
export const SiteMapPresignedUrlSchema = z.url({ protocol: /^https$/ }).refine(isSiteMapS3Url, {
  message: "S3 presigned host: HTTPS, S3 host, no credentials, no port, no fragment",
});

/**
 * Whether a raw value has an own property named as a prototype member. Checked on the input, because
 * the record schema drops a `__proto__` key from its output without refusing it.
 *
 * @param value - The raw value of the fields, before any schema has read it.
 * @returns True when the value is an object with one of the forbidden own property names.
 */
function hasForbiddenUploadFieldKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    [...FORBIDDEN_UPLOAD_FIELD_KEYS].some((name) => Object.hasOwn(value, name))
  );
}

/** Field name of a presigned POST form: the S3 form grammar, bounded in length. */
const UploadFieldKeySchema = z.string().regex(UPLOAD_FIELD_KEY_PATTERN);

/**
 * Fields of a presigned POST form: at most twenty, each name in the form grammar, the required ones present,
 * and no prototype member name in the raw input. The values are opaque to the console and bounded in length.
 */
export const UploadFieldsSchema = z
  .unknown()
  .refine((value) => !hasForbiddenUploadFieldKey(value), {
    message: "a form field name must not be a prototype property",
  })
  .pipe(
    z
      .record(UploadFieldKeySchema, z.string().max(MAX_UPLOAD_FIELD_VALUE_LENGTH))
      .refine((fields) => Object.keys(fields).length <= MAX_UPLOAD_FIELDS, {
        message: "a presigned upload has at most 20 fields",
      })
      .refine((fields) => REQUIRED_UPLOAD_FIELDS.every((name) => Object.hasOwn(fields, name)), {
        message: "a presigned upload names the key and the Content-Type fields",
      }),
  );

/**
 * Upload slot of a new map version. `url` and `fields` form a presigned POST: the browser posts the
 * fields in order, then the file. The URL is a credential for five minutes, so it is never logged.
 */
export const CreateMapResponseSchema = z.strictObject({
  version: MapVersionNumberSchema,
  upload: z.strictObject({
    url: SiteMapPresignedUrlSchema,
    fields: UploadFieldsSchema,
    expiresAt: IsoMsSchema,
  }),
  maxBytes: z.int().min(1).max(SITE_MAP_MAX_BYTES),
});

/** A validated upload slot. */
export type CreateMapResponse = z.infer<typeof CreateMapResponseSchema>;

/**
 * Presigned download of a `VALID` map version. It names the object version that was validated, so the
 * file the operator gets is the file that was checked, even if the key was overwritten since.
 */
export const MapUrlResponseSchema = z.strictObject({
  version: MapVersionNumberSchema,
  url: SiteMapPresignedUrlSchema,
  expiresAt: IsoMsSchema,
  sizeBytes: z.int().min(0).max(SITE_MAP_MAX_BYTES),
});

/** A validated presigned download. */
export type MapUrlResponse = z.infer<typeof MapUrlResponseSchema>;
