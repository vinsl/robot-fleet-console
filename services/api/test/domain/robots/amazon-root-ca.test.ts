/**
 * Integrity of the embedded Amazon Root CA 1: the pinned fingerprint and subject are the reviewed ones.
 */
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AMAZON_ROOT_CA_1_PEM } from "../../../src/domain/robots/amazon-root-ca";

/** SHA-256 fingerprint of Amazon Root CA 1, checked with openssl on 2026-11-02. */
const PINNED_FINGERPRINT =
  "8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E";

describe("AMAZON_ROOT_CA_1_PEM", () => {
  const certificate = new X509Certificate(AMAZON_ROOT_CA_1_PEM);

  it("matches the pinned SHA-256 fingerprint", () => {
    expect(certificate.fingerprint256).toBe(PINNED_FINGERPRINT);
  });

  it("is Amazon Root CA 1 and is valid until 2038", () => {
    expect(certificate.subject).toContain("CN=Amazon Root CA 1");
    expect(certificate.validTo).toBe("Jan 17 00:00:00 2038 GMT");
  });
});
