/**
 * Command publisher over the IoT data plane: one publish, QoS 1, the topic and the bytes, and no call above the limit.
 */
import { PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { describe, expect, it } from "vitest";
import { IotCommandPublisher, createIotDataClient } from "../../src/adapters/iot-publisher";
import { iotDataClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const TOPIC = "fleet/paris-01/sim-03/cmd";

describe("IotCommandPublisher", () => {
  it("publishes the payload bytes once, at QoS 1, on the topic", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({});
    await new IotCommandPublisher(iotDataClientStub(send)).publish(TOPIC, '{"type":"PAUSE"}');

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = sentCommands(send);
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command).toMatchObject({ input: { topic: TOPIC, qos: 1 } });
    const payload: unknown = (command as PublishCommand).input.payload;
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(payload as Uint8Array).toString("utf8")).toBe('{"type":"PAUSE"}');
  });

  it("refuses a payload above the MQTT limit before any call", async () => {
    const send = sendStub();
    const payload = "x".repeat(4097);
    await expect(
      new IotCommandPublisher(iotDataClientStub(send)).publish(TOPIC, payload),
    ).rejects.toThrow("command payload exceeds the MQTT limit");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not retry: a failed publish rejects after one call", async () => {
    const send = sendStub();
    send.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      new IotCommandPublisher(iotDataClientStub(send)).publish(TOPIC, "{}"),
    ).rejects.toThrow("throttled");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createIotDataClient", () => {
  it("is built on the data-plane endpoint with one attempt", async () => {
    const client = createIotDataClient("abc123-ats.iot.eu-west-3.amazonaws.com", "eu-west-3");
    expect(await client.config.maxAttempts()).toBe(1);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("abc123-ats.iot.eu-west-3.amazonaws.com");
  });
});
