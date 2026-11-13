/**
 * The vendored KVS WebRTC bundle is the file the manifest pins, and the viewer loads it from the path the build serves.
 * A changed or hand-edited bundle fails here rather than running unreviewed (ADR 0026, ADR 0067).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KVS_WEBRTC_SCRIPT_PATH } from "../../src/video/kvs-viewer";
import { KVS_WEBRTC_VENDOR } from "../../src/video/vendor-manifest";

/** Folder of the vendored bundle, resolved from this file so that the test is location independent. */
const PUBLIC_DIR = new URL("../../public/", import.meta.url);

/** The bundle as the build serves it. */
const BUNDLE = new URL("./vendor/kvs-webrtc.min.js", PUBLIC_DIR);

describe("vendored KVS WebRTC bundle", () => {
  it("has the SHA-256 pinned in the manifest", () => {
    const digest = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");

    expect(digest).toBe(KVS_WEBRTC_VENDOR.fileSha256);
  });

  it("has the sha384 Subresource Integrity pinned in the manifest", () => {
    const digest = createHash("sha384").update(readFileSync(BUNDLE)).digest("base64");

    expect(`sha384-${digest}`).toBe(KVS_WEBRTC_VENDOR.sha384Integrity);
  });

  it("announces the pinned version on its first line", () => {
    const firstLine = readFileSync(BUNDLE, "utf8").split("\n")[0];

    expect(firstLine).toContain(`v${KVS_WEBRTC_VENDOR.version}`);
  });

  it("ships the licence and notice files next to the bundle", () => {
    for (const name of ["kvs-webrtc.LICENSE", "LICENSE.txt", "NOTICE.txt"]) {
      expect(existsSync(new URL(`./vendor/${name}`, PUBLIC_DIR))).toBe(true);
    }
  });

  it("is served at the path the viewer loads it from", () => {
    expect(existsSync(new URL(`.${KVS_WEBRTC_SCRIPT_PATH}`, PUBLIC_DIR))).toBe(true);
  });
});
