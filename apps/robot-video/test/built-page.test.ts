/**
 * Checks of the built page that the agent serves (ADR 0037). They read the committed build, so they
 * fail when the build and the page source disagree, or when the build was edited by hand.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KVS_WEBRTC_VENDOR } from "../src/kvs/vendor-manifest";

/** The committed build of the page. */
const STATIC_DIR = new URL("../../../agent/src/fleet_agent/video/static/", import.meta.url);

const html = readFileSync(new URL("index.html", STATIC_DIR), "utf8");

/** Every `<script>` element of the built page, with its attributes and body. */
const SCRIPTS = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({
  attributes: match[1] ?? "",
  body: match[2] ?? "",
}));

describe("built index.html", () => {
  it("has no inline script body", () => {
    for (const script of SCRIPTS) {
      expect(script.body.trim(), script.attributes).toBe("");
    }
  });

  it("loads every script from the same origin", () => {
    for (const script of SCRIPTS) {
      const src = /\bsrc="([^"]*)"/.exec(script.attributes)?.[1];
      expect(src, script.attributes).toBeDefined();
      expect(src, src).toMatch(/^\/[^/]/);
    }
  });

  it("carries the pinned integrity on the vendored SDK tag", () => {
    const vendor = SCRIPTS.find((script) =>
      script.attributes.includes("/vendor/kvs-webrtc.min.js"),
    );
    expect(vendor?.attributes).toContain(`integrity="${KVS_WEBRTC_VENDOR.sha384Integrity}"`);
  });

  it("has no inline style attribute", () => {
    expect(html).not.toMatch(/\sstyle="/);
  });
});
