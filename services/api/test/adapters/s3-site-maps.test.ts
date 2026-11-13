/**
 * Map files over S3: the conditions of the presigned POST the browser posts, and the lifetime of the presigned
 * download. Presigning signs locally, so the tests make no call and use fake credentials.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3MapObjectStore } from "../../src/adapters/s3-site-maps";
import { FixedClock } from "../fakes/fixed";

const BUCKET = "mfc-demo-site-maps";
const NOW = new Date("2026-11-03T10:00:00.000Z");
const KEY = "sites/paris-01/maps/000001.geojson";
const TTL_MS = 300_000;

/** Store under test, over a client that signs with fake credentials and never reaches AWS. */
function store(): S3MapObjectStore {
  const client = new S3Client({
    region: "eu-west-3",
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
  });
  return new S3MapObjectStore(client, BUCKET, new FixedClock(NOW));
}

/**
 * Decodes the policy document of a presigned POST.
 *
 * @param policy - The base64 policy field of the form.
 * @returns The policy's expiration and conditions.
 */
function decodePolicy(policy: string): {
  expiration: string;
  conditions: unknown[];
} {
  const decoded: unknown = JSON.parse(Buffer.from(policy, "base64").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("policy is not an object");
  }
  const { expiration, conditions } = decoded as { expiration: unknown; conditions: unknown };
  if (typeof expiration !== "string" || !Array.isArray(conditions)) {
    throw new Error("policy has no expiration or conditions");
  }
  return { expiration, conditions };
}

describe("S3MapObjectStore.presignUpload", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts to the site maps bucket with the fixed key and the media type", async () => {
    const upload = await store().presignUpload(KEY);

    expect(upload.url).toContain(BUCKET);
    expect(upload.fields.key).toBe(KEY);
    expect(upload.fields["Content-Type"]).toBe("application/geo+json");
  });

  it("refuses any size outside 1 byte to 2 MB, any other media type, and any other key", async () => {
    const upload = await store().presignUpload(KEY);
    const { conditions } = decodePolicy(upload.fields.Policy ?? "");

    expect(conditions).toContainEqual(["content-length-range", 1, 2_000_000]);
    expect(conditions).toContainEqual(["eq", "$Content-Type", "application/geo+json"]);
    expect(conditions).toContainEqual({ key: KEY });
    expect(conditions).toContainEqual({ bucket: BUCKET });
  });

  it("expires after 300 seconds, in the policy and in the returned instant", async () => {
    const upload = await store().presignUpload(KEY);

    // The policy writes the instant without milliseconds, so the comparison is made on the instant.
    expect(Date.parse(decodePolicy(upload.fields.Policy ?? "").expiration)).toBe(
      NOW.getTime() + TTL_MS,
    );
    expect(upload.expiresAt).toBe(new Date(NOW.getTime() + TTL_MS).toISOString());
  });
});

describe("S3MapObjectStore.presignDownload", () => {
  it("names the object version and expires after 300 seconds", async () => {
    const download = await store().presignDownload(KEY, "v-pinned-1", 1);
    const url = new URL(download.url);

    expect(url.searchParams.get("versionId")).toBe("v-pinned-1");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(download.expiresAt).toBe(new Date(NOW.getTime() + TTL_MS).toISOString());
  });

  it("serves the file as an attachment named after the integer version, never after the site", async () => {
    const download = await store().presignDownload(KEY, "v-pinned-1", 7);
    const url = new URL(download.url);

    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="site-map-v7.geojson"',
    );
    expect(url.searchParams.get("response-content-type")).toBe("application/geo+json");
  });
});
