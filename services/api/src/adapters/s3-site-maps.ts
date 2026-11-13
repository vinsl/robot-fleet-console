/**
 * Map files over S3: presigned uploads, metadata, capped reads of one object version, and presigned downloads.
 *
 * The bucket is versioned, so every read names the object version it means: a later upload to the same key is a
 * new version, and the validated one stays the one that is read and downloaded. The upload policy carries the size
 * and the media type, so the browser cannot send a file the validation would refuse anyway.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SITE_MAP_CONTENT_TYPE,
  SITE_MAP_DOWNLOAD_TTL_S,
  SITE_MAP_MAX_BYTES,
  SITE_MAP_UPLOAD_TTL_S,
} from "@mfc/protocol";
import type { Clock } from "../domain/ports";
import {
  MapObjectTooLargeError,
  type MapObjectHead,
  type MapObjectStore,
  type MapObjectText,
  type PresignedDownload,
  type PresignedUpload,
} from "../domain/site/ports";
import { isAwsError } from "./aws-errors";

/** Smallest accepted upload, in bytes: an empty file is refused by the policy. */
const MIN_UPLOAD_BYTES = 1;

/** Object store of the map files over one bucket. */
export class S3MapObjectStore implements MapObjectStore {
  /**
   * @param s3 - The S3 client. Presigning signs locally; reads and heads make calls.
   * @param bucket - The site maps bucket.
   * @param clock - Clock of the expiry instants returned to the caller.
   */
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly clock: Clock,
  ) {}

  /**
   * Presigns a POST upload. The policy fixes the size range, the media type and the key; the form is valid for
   * the upload TTL and no longer.
   *
   * @param key - Object key, chosen by the server.
   * @returns The URL, the form fields and the expiry.
   */
  async presignUpload(key: string): Promise<PresignedUpload> {
    const post = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", MIN_UPLOAD_BYTES, SITE_MAP_MAX_BYTES],
        ["eq", "$Content-Type", SITE_MAP_CONTENT_TYPE],
      ],
      Fields: { "Content-Type": SITE_MAP_CONTENT_TYPE },
      Expires: SITE_MAP_UPLOAD_TTL_S,
    });
    return {
      url: post.url,
      fields: post.fields,
      expiresAt: expiryAt(this.clock.now().getTime(), SITE_MAP_UPLOAD_TTL_S),
    };
  }

  /**
   * Reads the metadata of the current object of a key.
   *
   * @param key - Object key.
   * @returns The metadata, or `null` when no object exists at the key.
   * @throws When the response carries no version identifier: the bucket is then not versioned, which is a deployment
   * error.
   */
  async head(key: string): Promise<MapObjectHead | null> {
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (
        result.ContentLength === undefined ||
        result.ContentType === undefined ||
        result.VersionId === undefined
      ) {
        throw new Error("object metadata is incomplete");
      }
      return {
        sizeBytes: result.ContentLength,
        contentType: result.ContentType,
        versionId: result.VersionId,
      };
    } catch (error) {
      if (isAwsError(error, "NotFound", "NoSuchKey")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Reads the text of one object version. The declared size is checked first, then the stream is read chunk by
   * chunk and stopped as soon as the cap is passed, so a stream that lies about its size is still bounded.
   *
   * @param key - Object key.
   * @param versionId - The object version to read.
   * @param maxBytes - The largest size accepted.
   * @returns The text, decoded as UTF-8, and the SHA-256 of the bytes.
   * @throws {MapObjectTooLargeError} When the object is larger than `maxBytes`.
   */
  async readText(key: string, versionId: string, maxBytes: number): Promise<MapObjectText> {
    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }),
    );
    const body = result.Body;
    if (body === undefined || !(body instanceof Readable)) {
      throw new Error("object body is not a stream");
    }
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
      body.destroy();
      throw new MapObjectTooLargeError();
    }

    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      const bytes: unknown = chunk;
      if (!(bytes instanceof Uint8Array)) {
        body.destroy();
        throw new Error("object chunk is not bytes");
      }
      total += bytes.byteLength;
      if (total > maxBytes) {
        body.destroy();
        throw new MapObjectTooLargeError();
      }
      hash.update(bytes);
      chunks.push(bytes);
    }
    return {
      text: Buffer.concat(chunks).toString("utf8"),
      sha256: hash.digest("hex"),
    };
  }

  /**
   * Presigns a download of one object version, served as an attachment named after the map version. The name is
   * built here from the integer version only: a site identifier or any other caller input never reaches a header.
   *
   * @param key - Object key.
   * @param versionId - The object version to download.
   * @param version - The map version number.
   * @returns The URL and its expiry.
   */
  async presignDownload(
    key: string,
    versionId: string,
    version: number,
  ): Promise<PresignedDownload> {
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
        ResponseContentType: SITE_MAP_CONTENT_TYPE,
        ResponseContentDisposition: `attachment; filename="site-map-v${String(version)}.geojson"`,
      }),
      { expiresIn: SITE_MAP_DOWNLOAD_TTL_S },
    );
    return { url, expiresAt: expiryAt(this.clock.now().getTime(), SITE_MAP_DOWNLOAD_TTL_S) };
  }
}

/**
 * Expiry instant of a presigned URL created now.
 *
 * @param nowMs - The current instant, in milliseconds since the epoch.
 * @param ttlS - The lifetime of the URL, in seconds: the upload or the download lifetime.
 * @returns The expiry, ISO 8601 with milliseconds.
 */
function expiryAt(nowMs: number, ttlS: number): string {
  return new Date(nowMs + ttlS * 1000).toISOString();
}
