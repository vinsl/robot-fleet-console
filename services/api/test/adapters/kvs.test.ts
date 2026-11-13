/**
 * Video adapter over Kinesis Video Streams: channel creation and reuse, deletion, and the mapping of error
 * codes to the outcomes of the port.
 */
import {
  CreateSignalingChannelCommand,
  DeleteSignalingChannelCommand,
  DescribeSignalingChannelCommand,
} from "@aws-sdk/client-kinesis-video";
import type { ThingName } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { AwsKvs } from "../../src/adapters/kvs";
import type { ResourceTags } from "../../src/config/env";
import { RobotsError } from "../../src/domain/robots/problems";
import { awsError } from "../fakes/call-gate";
import { kinesisClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const NAME = "mfc-demo-kali-01" as ThingName;
const CHANNEL_ARN = `arn:aws:kinesisvideo:eu-west-3:123456789012:channel/${NAME}/1700000000000`;
const TAGS: ResourceTags = { project: "mfc", env: "demo", component: "robots", owner: "vincent" };

describe("AwsKvs.createChannel", () => {
  it("creates a single-master channel with a 60 s message TTL and the resource tags", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ ChannelARN: CHANNEL_ARN });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.createChannel(NAME, TAGS)).resolves.toStrictEqual({ channelArn: CHANNEL_ARN });

    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(CreateSignalingChannelCommand);
    expect(command).toMatchObject({
      input: {
        ChannelName: NAME,
        ChannelType: "SINGLE_MASTER",
        SingleMasterConfiguration: { MessageTtlSeconds: 60 },
        Tags: [
          { Key: "project", Value: "mfc" },
          { Key: "env", Value: "demo" },
          { Key: "component", Value: "robots" },
          { Key: "owner", Value: "vincent" },
        ],
      },
    });
  });

  it("refuses a response without a valid channel ARN", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ ChannelARN: "arn:aws:kinesisvideo:us-east-1:1:channel/x/1" });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.createChannel(NAME, TAGS)).rejects.toMatchObject({
      code: "provisioning-failed",
    });
  });

  it("reuses an existing channel that is active", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ResourceInUseException"));
    send.mockResolvedValueOnce({
      ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: "ACTIVE" },
    });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.createChannel(NAME, TAGS)).resolves.toStrictEqual({ channelArn: CHANNEL_ARN });

    expect(sentCommands(send)[1]).toBeInstanceOf(DescribeSignalingChannelCommand);
    expect(sentCommands(send)[1]).toMatchObject({ input: { ChannelName: NAME } });
  });

  it("reuses an existing channel that is still being created", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ResourceInUseException"));
    send.mockResolvedValueOnce({
      ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: "CREATING" },
    });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.createChannel(NAME, TAGS)).resolves.toStrictEqual({ channelArn: CHANNEL_ARN });
  });

  it.each(["DELETING", "UPDATING"])(
    "fails the registration when the existing channel is %s",
    async (status) => {
      const send = sendStub();
      send.mockRejectedValueOnce(awsError("ResourceInUseException"));
      send.mockResolvedValueOnce({
        ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: status },
      });
      const kvs = new AwsKvs(kinesisClientStub(send));

      await expect(kvs.createChannel(NAME, TAGS)).rejects.toMatchObject({
        code: "provisioning-failed",
      });
    },
  );

  it("fails the registration when the existing channel has no valid ARN", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ResourceInUseException"));
    send.mockResolvedValueOnce({ ChannelInfo: { ChannelStatus: "ACTIVE" } });
    const kvs = new AwsKvs(kinesisClientStub(send));

    const outcome = kvs.createChannel(NAME, TAGS);
    await expect(outcome).rejects.toBeInstanceOf(RobotsError);
    await expect(outcome).rejects.toMatchObject({ code: "provisioning-failed" });
  });

  it("rethrows a creation failure that is not an existing channel", async () => {
    const send = sendStub();
    const failure = awsError("AccessDeniedException");
    send.mockRejectedValueOnce(failure);
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.createChannel(NAME, TAGS)).rejects.toBe(failure);
  });
});

describe("AwsKvs.deleteChannel", () => {
  it("describes the channel, then deletes it by ARN", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: "ACTIVE" },
    });
    send.mockResolvedValueOnce({});
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).resolves.toBe("deleted");

    const [describe, remove] = sentCommands(send);
    expect(describe).toBeInstanceOf(DescribeSignalingChannelCommand);
    expect(describe).toMatchObject({ input: { ChannelName: NAME } });
    expect(remove).toBeInstanceOf(DeleteSignalingChannelCommand);
    expect(remove).toMatchObject({ input: { ChannelARN: CHANNEL_ARN } });
  });

  it("reports absent when the channel does not exist", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(awsError("ResourceNotFoundException"));
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).resolves.toBe("absent");
    expect(sentCommands(send)).toHaveLength(1);
  });

  it("reports absent without deleting when the channel is already being deleted", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: "DELETING" },
    });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).resolves.toBe("absent");
    expect(sentCommands(send)).toHaveLength(1);
  });

  it("reports absent when the channel vanishes between the describe and the delete", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({
      ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: "ACTIVE" },
    });
    send.mockRejectedValueOnce(awsError("ResourceNotFoundException"));
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).resolves.toBe("absent");
  });

  it("fails when the channel has no valid ARN to delete", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ ChannelInfo: { ChannelStatus: "ACTIVE" } });
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).rejects.toMatchObject({ code: "provisioning-failed" });
  });

  it("rethrows a failure of the describe", async () => {
    const send = sendStub();
    const failure = awsError("ThrottlingException");
    send.mockRejectedValueOnce(failure);
    const kvs = new AwsKvs(kinesisClientStub(send));

    await expect(kvs.deleteChannel(NAME)).rejects.toBe(failure);
  });
});
