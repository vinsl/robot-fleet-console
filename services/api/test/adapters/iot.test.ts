/**
 * IoT adapter over the AWS SDK: the commands sent, the retry policy of each client, and the mapping of
 * error codes to the outcomes of the port.
 */
import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateKeysAndCertificateCommand,
  CreateThingCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  ListThingPrincipalsCommand,
  UpdateCertificateCommand,
} from "@aws-sdk/client-iot";
import { DeleteConnectionCommand } from "@aws-sdk/client-iot-data-plane";
import type { ThingName } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { AwsIot } from "../../src/adapters/iot";
import { RobotsError } from "../../src/domain/robots/problems";
import { awsError } from "../fakes/call-gate";
import {
  iotClientStub,
  iotDataClientStub,
  sendStub,
  sentCommands,
  type SendMock,
} from "../fakes/sdk-stub";

const THING = "mfc-demo-kali-01" as ThingName;
const POLICY = "mfc-demo-robot";
const CERT_ID = "ab".repeat(32);
const CERT_ARN = `arn:aws:iot:eu-west-3:123456789012:cert/${CERT_ID}`;
const OTHER_ARN = `arn:aws:iot:eu-west-3:123456789012:cert/${"cd".repeat(32)}`;
const COGNITO_PRINCIPAL = "arn:aws:cognito-identity:eu-west-3:123456789012:identitypool/x";
const PEM_CERT = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
const PEM_KEY_BODY = "ZmFrZSBrZXk=";

/**
 * Builds an adapter over three stubs, one per client.
 *
 * @returns The adapter and the mock of each client.
 */
function build(): { iot: AwsIot; control: SendMock; noRetry: SendMock; data: SendMock } {
  const control = sendStub();
  const noRetry = sendStub();
  const data = sendStub();
  const iot = new AwsIot({
    iot: iotClientStub(control),
    iotNoRetry: iotClientStub(noRetry),
    iotData: iotDataClientStub(data),
  });
  return { iot, control, noRetry, data };
}

describe("AwsIot.createThing", () => {
  it("creates the thing with its two attributes, replacing none", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});

    await iot.createThing(THING, { robotId: "kali-01", siteId: "paris-01" });

    const [command] = sentCommands(control);
    expect(command).toBeInstanceOf(CreateThingCommand);
    expect(command).toMatchObject({
      input: {
        thingName: THING,
        attributePayload: { attributes: { robotId: "kali-01", siteId: "paris-01" }, merge: false },
      },
    });
  });

  it("reports a provisioning failure when the thing exists with other attributes", async () => {
    const { iot, control } = build();
    control.mockRejectedValueOnce(awsError("ResourceAlreadyExistsException"));

    const outcome = iot.createThing(THING, { robotId: "kali-01", siteId: "paris-01" });
    await expect(outcome).rejects.toBeInstanceOf(RobotsError);
    await expect(outcome).rejects.toMatchObject({ code: "provisioning-failed" });
  });
});

describe("AwsIot.createInactiveCertificate", () => {
  it("creates the certificate with the single-attempt client, inactive, and returns its material", async () => {
    const { iot, control, noRetry } = build();
    noRetry.mockResolvedValueOnce({
      certificateId: CERT_ID,
      certificateArn: CERT_ARN,
      certificatePem: PEM_CERT,
      keyPair: { PrivateKey: PEM_KEY_BODY, PublicKey: "public" },
    });

    await expect(iot.createInactiveCertificate()).resolves.toStrictEqual({
      certificateId: CERT_ID,
      certificateArn: CERT_ARN,
      certificatePem: PEM_CERT,
      privateKeyPem: PEM_KEY_BODY,
    });

    const [command] = sentCommands(noRetry);
    expect(command).toBeInstanceOf(CreateKeysAndCertificateCommand);
    expect(command).toMatchObject({ input: { setAsActive: false } });
    expect(sentCommands(control)).toEqual([]);
  });

  it("refuses a response without the key, and the error names no field value", async () => {
    const { iot, noRetry } = build();
    noRetry.mockResolvedValueOnce({
      certificateId: CERT_ID,
      certificateArn: CERT_ARN,
      certificatePem: PEM_CERT,
    });

    const outcome = iot.createInactiveCertificate();
    await expect(outcome).rejects.toMatchObject({
      code: "provisioning-failed",
      message: "provisioning-failed",
    });
  });

  it("refuses a certificate identifier outside the registry grammar", async () => {
    const { iot, noRetry } = build();
    noRetry.mockResolvedValueOnce({
      certificateId: "NOT-HEX",
      certificateArn: CERT_ARN,
      certificatePem: PEM_CERT,
      keyPair: { PrivateKey: PEM_KEY_BODY },
    });

    await expect(iot.createInactiveCertificate()).rejects.toMatchObject({
      code: "provisioning-failed",
    });
  });
});

describe("AwsIot attachments and activation", () => {
  it("attaches the policy to the certificate", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});

    await iot.attachPolicy(POLICY, CERT_ARN);

    const [command] = sentCommands(control);
    expect(command).toBeInstanceOf(AttachPolicyCommand);
    expect(command).toMatchObject({ input: { policyName: POLICY, target: CERT_ARN } });
  });

  it("attaches the certificate as the exclusive principal of the thing", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});

    await iot.attachExclusiveThing(THING, CERT_ARN);

    const [command] = sentCommands(control);
    expect(command).toBeInstanceOf(AttachThingPrincipalCommand);
    expect(command).toMatchObject({
      input: { thingName: THING, principal: CERT_ARN, thingPrincipalType: "EXCLUSIVE_THING" },
    });
  });

  it("activates the certificate and rethrows a failure", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});
    await iot.activateCertificate(CERT_ID);
    expect(sentCommands(control)[0]).toMatchObject({
      input: { certificateId: CERT_ID, newStatus: "ACTIVE" },
    });

    const failure = awsError("CertificateStateException");
    control.mockRejectedValueOnce(failure);
    await expect(iot.activateCertificate(CERT_ID)).rejects.toBe(failure);
  });
});

describe("AwsIot.revokeCertificate", () => {
  it("revokes the certificate", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});

    await iot.revokeCertificate(CERT_ID);

    expect(sentCommands(control)[0]).toBeInstanceOf(UpdateCertificateCommand);
    expect(sentCommands(control)[0]).toMatchObject({
      input: { certificateId: CERT_ID, newStatus: "REVOKED" },
    });
  });

  it.each(["CertificateStateException", "ResourceNotFoundException"])(
    "succeeds when the certificate is already in the wanted state or absent (%s)",
    async (code) => {
      const { iot, control } = build();
      control.mockRejectedValueOnce(awsError(code));

      await expect(iot.revokeCertificate(CERT_ID)).resolves.toBeUndefined();
    },
  );

  it("propagates an invalid request, which is not a met goal", async () => {
    const { iot, control } = build();
    const failure = awsError("InvalidRequestException");
    control.mockRejectedValueOnce(failure);

    await expect(iot.revokeCertificate(CERT_ID)).rejects.toBe(failure);
  });

  it("rethrows any other failure", async () => {
    const { iot, control } = build();
    const failure = awsError("ThrottlingException");
    control.mockRejectedValueOnce(failure);

    await expect(iot.revokeCertificate(CERT_ID)).rejects.toBe(failure);
  });
});

describe("AwsIot detachments", () => {
  it("detaches the policy, and succeeds when the attachment is absent", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});
    await iot.detachPolicy(POLICY, CERT_ARN);
    expect(sentCommands(control)[0]).toBeInstanceOf(DetachPolicyCommand);
    expect(sentCommands(control)[0]).toMatchObject({
      input: { policyName: POLICY, target: CERT_ARN },
    });

    control.mockRejectedValueOnce(awsError("ResourceNotFoundException"));
    await expect(iot.detachPolicy(POLICY, CERT_ARN)).resolves.toBeUndefined();
  });

  it("detaches the thing principal, and succeeds when the attachment is absent", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({});
    await iot.detachThing(THING, CERT_ARN);
    expect(sentCommands(control)[0]).toBeInstanceOf(DetachThingPrincipalCommand);
    expect(sentCommands(control)[0]).toMatchObject({
      input: { thingName: THING, principal: CERT_ARN },
    });

    control.mockRejectedValueOnce(awsError("ResourceNotFoundException"));
    await expect(iot.detachThing(THING, CERT_ARN)).resolves.toBeUndefined();
  });

  it("rethrows a detachment failure that is not a missing attachment", async () => {
    const { iot, control } = build();
    const failure = awsError("InternalFailureException");
    control.mockRejectedValueOnce(failure);

    await expect(iot.detachThing(THING, CERT_ARN)).rejects.toBe(failure);
  });
});

describe("AwsIot.listThingCertificateArns", () => {
  it("reads every page and keeps only the certificate principals", async () => {
    const { iot, control } = build();
    control.mockResolvedValueOnce({
      principals: [CERT_ARN, COGNITO_PRINCIPAL],
      nextToken: "page-2",
    });
    control.mockResolvedValueOnce({ principals: [OTHER_ARN] });

    await expect(iot.listThingCertificateArns(THING)).resolves.toStrictEqual([CERT_ARN, OTHER_ARN]);

    const [first, second] = sentCommands(control);
    expect(first).toBeInstanceOf(ListThingPrincipalsCommand);
    expect(first).toMatchObject({
      input: { thingName: THING, maxResults: 25, nextToken: undefined },
    });
    expect(second).toMatchObject({
      input: { thingName: THING, maxResults: 25, nextToken: "page-2" },
    });
  });

  it("returns an empty list when the thing does not exist", async () => {
    const { iot, control } = build();
    control.mockRejectedValueOnce(awsError("ResourceNotFoundException"));

    await expect(iot.listThingCertificateArns(THING)).resolves.toStrictEqual([]);
  });

  it("fails rather than silently truncating a listing longer than the page bound", async () => {
    const { iot, control } = build();
    for (let page = 0; page < 4; page += 1) {
      control.mockResolvedValueOnce({
        principals: [CERT_ARN],
        nextToken: `page-${String(page + 1)}`,
      });
    }

    const outcome = iot.listThingCertificateArns(THING);
    await expect(outcome).rejects.toMatchObject({ code: "internal" });
    expect(sentCommands(control)).toHaveLength(4);
  });
});

describe("AwsIot.disconnect", () => {
  it("ends the session without its last will and without keeping the session state", async () => {
    const { iot, data } = build();
    data.mockResolvedValueOnce({});

    await iot.disconnect(THING);

    const [command] = sentCommands(data);
    expect(command).toBeInstanceOf(DeleteConnectionCommand);
    expect(command).toMatchObject({
      input: { clientId: THING, cleanSession: true, preventWillMessage: true },
    });
  });

  it("succeeds when no session is open", async () => {
    const { iot, data } = build();
    data.mockRejectedValueOnce(awsError("ResourceNotFoundException"));

    await expect(iot.disconnect(THING)).resolves.toBeUndefined();
  });
});
