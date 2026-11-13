import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KVS_WEBRTC_VENDOR } from "../src/kvs/vendor-manifest";

/** Folder of the vendored bundle, resolved from this file so that the test is location independent. */
const VENDOR_DIR = new URL("../public/vendor/", import.meta.url);

/** Folder of the HTML page, which loads the bundle. */
const PAGES_DIR = new URL("../", import.meta.url);

/** The pages that load the bundle with a script tag. */
const PAGES = ["index.html"] as const;

describe("vendored KVS WebRTC bundle", () => {
  it("has the SHA-256 pinned in the manifest", () => {
    const bytes = readFileSync(new URL("kvs-webrtc.min.js", VENDOR_DIR));
    const digest = createHash("sha256").update(bytes).digest("hex");

    expect(digest).toBe(KVS_WEBRTC_VENDOR.fileSha256);
  });

  it("announces the pinned version on its first line", () => {
    const firstLine = readFileSync(new URL("kvs-webrtc.min.js", VENDOR_DIR), "utf8").split("\n")[0];

    expect(firstLine).toContain(`v${KVS_WEBRTC_VENDOR.version}`);
  });

  it("ships the licence and notice files next to the bundle", () => {
    for (const name of ["kvs-webrtc.LICENSE", "LICENSE.txt", "NOTICE.txt"]) {
      expect(existsSync(new URL(name, VENDOR_DIR))).toBe(true);
    }
  });

  it("has the sha384 Subresource Integrity pinned in the manifest", () => {
    const bytes = readFileSync(new URL("kvs-webrtc.min.js", VENDOR_DIR));
    const digest = createHash("sha384").update(bytes).digest("base64");

    expect(`sha384-${digest}`).toBe(KVS_WEBRTC_VENDOR.sha384Integrity);
  });

  it.each(PAGES)("loads the bundle in %s with the pinned integrity", (page) => {
    const html = readFileSync(new URL(page, PAGES_DIR), "utf8");
    const tag = /<script\b[^>]*\bsrc="\/vendor\/kvs-webrtc\.min\.js"[^>]*>/.exec(html)?.[0];

    expect(tag).toBeDefined();
    expect(tag).toContain(`integrity="${KVS_WEBRTC_VENDOR.sha384Integrity}"`);
  });
});
