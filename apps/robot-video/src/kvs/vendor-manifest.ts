/**
 * Pinned identity of the vendored KVS WebRTC browser bundle (ADR 0026).
 *
 * The values are the output of `scripts/vendor-kvs-webrtc.sh`, except `sha384Integrity`, which is
 * computed from the same file and written here by hand. Unit tests check the vendored file against
 * both digests, and the page against the integrity value, so that a changed or hand-edited bundle
 * fails the build rather than running unreviewed. Changing the SDK means running the script again,
 * computing the sha384 of the new file, and changing these values in the same commit.
 */
export const KVS_WEBRTC_VENDOR = {
  version: "2.9.0",
  publishedAt: "2026-08-20T22:27:59.963Z",
  npmIntegrity:
    "sha512-GIAni+KW7TVWPd4LWHSr/0HtYnIDAgFqSaVxk17UKfX15hmXWpf2XyHSCBz1nI6pY076jIn1U4uYuxPNbaWhTw==",
  fileSha256: "779d2518ade088267639634dde220626e1f44732d4f780f4d8829d1d5618badf",
  /**
   * Subresource Integrity value of the same file, in the form the page puts in its `integrity`
   * attribute. The browser refuses the script if the file differs.
   */
  sha384Integrity: "sha384-G0UVZqeJomjXpY5peRUwBuzPruXUFJL+R5KJnpICQUxKUfZdMDKZk7xIW+2H78B3",
} as const;
