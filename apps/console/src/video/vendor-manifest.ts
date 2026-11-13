/**
 * Pinned identity of the vendored KVS WebRTC browser bundle (ADR 0026, ADR 0067).
 *
 * The bundle is restored byte for byte from the video spike's history, so its values are the ones the spike
 * pinned: the SHA-256 of the file, and the Subresource Integrity value the console puts on the script element.
 * `test/video/vendor.test.ts` recomputes both from the file, so a changed or hand-edited bundle fails the tests
 * rather than running unreviewed. An update means running the vendor procedure again and changing these values
 * in the same commit.
 */
export const KVS_WEBRTC_VENDOR = {
  version: "2.9.0",
  publishedAt: "2026-08-20T22:27:59.963Z",
  npmIntegrity:
    "sha512-GIAni+KW7TVWPd4LWHSr/0HtYnIDAgFqSaVxk17UKfX15hmXWpf2XyHSCBz1nI6pY076jIn1U4uYuxPNbaWhTw==",
  fileSha256: "779d2518ade088267639634dde220626e1f44732d4f780f4d8829d1d5618badf",
  /**
   * Subresource Integrity of the same file. The browser refuses the script if the bytes differ, even though the
   * file is served from the console's own origin.
   */
  sha384Integrity: "sha384-G0UVZqeJomjXpY5peRUwBuzPruXUFJL+R5KJnpICQUxKUfZdMDKZk7xIW+2H78B3",
} as const;
