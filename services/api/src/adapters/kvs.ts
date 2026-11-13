/**
 * Video channels of the robots over Kinesis Video Streams, one single-master channel per thing.
 *
 * A channel named after the thing is what the credentials policy binds to: the robot can only be master
 * of its own channel. The adapter reads every service response through the shared ARN grammar, so an
 * unexpected value fails the registration instead of reaching the kit.
 */
import {
  CreateSignalingChannelCommand,
  DeleteSignalingChannelCommand,
  DescribeSignalingChannelCommand,
  type KinesisVideoClient,
} from "@aws-sdk/client-kinesis-video";
import { KvsChannelArnSchema, type ThingName } from "@mfc/protocol";
import type { ResourceTags } from "../config/env";
import type { KvsPort } from "../domain/ports";
import { RobotsError } from "../domain/robots/problems";
import { isAwsError } from "./aws-errors";

/** Message time-to-live of the channel, in seconds. Signalling messages are only useful while fresh. */
const MESSAGE_TTL_SECONDS = 60;

/** Video channels over the AWS SDK. */
export class AwsKvs implements KvsPort {
  /** @param client - The Kinesis Video client. Only `send` is used, so tests can supply a double. */
  constructor(private readonly client: Pick<KinesisVideoClient, "send">) {}

  /**
   * Creates the channel. When it already exists, the channel is reused if it is active or being created,
   * and refused if it is being deleted or updated: the registration then fails, and the retry runs after
   * the deletion.
   *
   * @param name - Channel name, the thing name.
   * @param tags - Tags of the channel.
   * @returns The channel ARN.
   * @throws {RobotsError} With code `provisioning-failed` for a channel in a transitional state that
   * cannot be reused, or for a response that does not carry a valid ARN.
   */
  async createChannel(name: ThingName, tags: ResourceTags): Promise<{ channelArn: string }> {
    try {
      const output = await this.client.send(
        new CreateSignalingChannelCommand({
          ChannelName: name,
          ChannelType: "SINGLE_MASTER",
          SingleMasterConfiguration: { MessageTtlSeconds: MESSAGE_TTL_SECONDS },
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
      return { channelArn: validArnOrFail(output.ChannelARN) };
    } catch (error) {
      if (!isAwsError(error, "ResourceInUseException")) {
        throw error;
      }
    }

    const described = await this.client.send(
      new DescribeSignalingChannelCommand({ ChannelName: name }),
    );
    const status = described.ChannelInfo?.ChannelStatus;
    if (status !== "ACTIVE" && status !== "CREATING") {
      throw new RobotsError("provisioning-failed");
    }
    return { channelArn: validArnOrFail(described.ChannelInfo?.ChannelARN) };
  }

  /**
   * Deletes the channel named after the thing. Describing it first gives the ARN that deletion needs.
   *
   * @param name - Channel name, the thing name.
   * @returns `deleted` when this call removed it; `absent` when it does not exist, or is already being
   * deleted.
   * @throws {RobotsError} With code `provisioning-failed` when the channel has no valid ARN.
   */
  async deleteChannel(name: ThingName): Promise<"deleted" | "absent"> {
    let described;
    try {
      described = await this.client.send(
        new DescribeSignalingChannelCommand({ ChannelName: name }),
      );
    } catch (error) {
      if (isAwsError(error, "ResourceNotFoundException")) {
        return "absent";
      }
      throw error;
    }
    const info = described.ChannelInfo;
    if (info?.ChannelStatus === "DELETING") {
      return "absent";
    }

    const channelArn = validArnOrFail(info?.ChannelARN);
    try {
      await this.client.send(new DeleteSignalingChannelCommand({ ChannelARN: channelArn }));
      return "deleted";
    } catch (error) {
      if (isAwsError(error, "ResourceNotFoundException")) {
        return "absent";
      }
      throw error;
    }
  }
}

/**
 * Accepts a channel ARN from a service response, or fails the provisioning step.
 *
 * @param value - The ARN as returned by the service, possibly absent.
 * @returns The ARN, once it matches the channel grammar of the demo regions.
 * @throws {RobotsError} With code `provisioning-failed` when the value is absent or malformed.
 */
function validArnOrFail(value: string | undefined): string {
  const parsed = KvsChannelArnSchema.safeParse(value);
  if (!parsed.success) {
    throw new RobotsError("provisioning-failed");
  }
  return parsed.data;
}
