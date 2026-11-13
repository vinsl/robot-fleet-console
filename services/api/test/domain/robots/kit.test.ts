/**
 * Kit building: a valid kit passes the shared schema, CRLF input is normalised, and a malformed key is refused
 * without echoing it.
 */
import { RobotKitSchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { AMAZON_ROOT_CA_1_PEM } from "../../../src/domain/robots/amazon-root-ca";
import { buildKit, type KitInput } from "../../../src/domain/robots/kit";
import { RobotsError } from "../../../src/domain/robots/problems";
import { createWorld, recordOf, TEST_CONFIG } from "../../fakes/world";
import { FAKE_KEY_BODY } from "../../fakes/fake-iot";

/** Builds the kit input of the reference robot from a fresh fake certificate. */
async function inputWith(
  transform: (pem: { certificatePem: string; privateKeyPem: string }) => {
    certificatePem: string;
    privateKeyPem: string;
  },
): Promise<KitInput> {
  const world = createWorld();
  const created = await world.iot.createInactiveCertificate();
  const pems = transform({
    certificatePem: created.certificatePem,
    privateKeyPem: created.privateKeyPem,
  });
  return {
    record: recordOf(),
    cert: { ...created, ...pems },
    channelArn: "arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-kali-01/1001",
    config: TEST_CONFIG,
  };
}

describe("buildKit", () => {
  it("builds a kit that passes the shared schema, with the root CA and the names of the robot", async () => {
    const kit = buildKit(await inputWith((pem) => pem));
    expect(RobotKitSchema.safeParse(kit).success).toBe(true);
    expect(kit.rootCaPem).toBe(AMAZON_ROOT_CA_1_PEM);
    expect(kit.config).toStrictEqual({
      robotId: "kali-01",
      siteId: "paris-01",
      thingName: "mfc-demo-kali-01",
      simulated: true,
      region: "eu-west-3",
      iotEndpoint: TEST_CONFIG.iotEndpoint,
      credentialsEndpoint: TEST_CONFIG.credentialsEndpoint,
      roleAlias: "mfc-demo-robot-kvs-master",
      kvsChannelName: "mfc-demo-kali-01",
      kvsChannelArn: "arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-kali-01/1001",
    });
  });

  it("normalises CRLF line endings before validation", async () => {
    const kit = buildKit(
      await inputWith((pem) => ({
        certificatePem: pem.certificatePem.replace(/\n/g, "\r\n"),
        privateKeyPem: pem.privateKeyPem.replace(/\n/g, "\r\n"),
      })),
    );
    expect(kit.privateKeyPem).not.toContain("\r");
    expect(kit.certificatePem).not.toContain("\r");
  });

  it("refuses a malformed key with provisioning-failed, without echoing the input", async () => {
    const input = await inputWith((pem) => ({
      certificatePem: pem.certificatePem,
      privateKeyPem: `not a key ${FAKE_KEY_BODY}`,
    }));
    let thrown: unknown;
    try {
      buildKit(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RobotsError);
    expect(thrown).toHaveProperty("code", "provisioning-failed");
    expect(String(thrown)).not.toContain(FAKE_KEY_BODY);
  });
});
