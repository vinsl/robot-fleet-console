/**
 * Command publisher over the IoT data plane: one publish per command, at QoS 1, with no SDK retry.
 *
 * A retried publish would reach the robot twice, and the robot would answer the second copy `DUPLICATE` after its
 * first ACK. With one attempt, a failure is a clean `upstream-failed` and the console can send the same command again
 * with the same identifier, which the claim makes safe (ADR 0062, D9).
 */
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { MAX_MQTT_PAYLOAD_BYTES, type AwsRegion } from "@mfc/protocol";
import type { CommandPublisherPort } from "../domain/control/ports";

/** Time the publisher waits for a connection to the data plane, in milliseconds. */
const CONNECT_TIMEOUT_MS = 2000;

/** Time the publisher waits for the publish to be accepted, in milliseconds. */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * Builds the IoT data-plane client of the control function. Constructing it makes no call.
 *
 * @param endpoint - The data-plane host, without a scheme, validated by the environment schema.
 * @param region - The region of the stack, used to sign the requests.
 * @returns The client, with one attempt and a 2 s connect and request timeout.
 */
export function createIotDataClient(endpoint: string, region: AwsRegion): IoTDataPlaneClient {
  return new IoTDataPlaneClient({
    endpoint: `https://${endpoint}`,
    region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: CONNECT_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
  });
}

/** Publishes commands on the IoT data plane. */
export class IotCommandPublisher implements CommandPublisherPort {
  /**
   * @param client - The data-plane client. Only `send` is used, so tests can supply a double.
   */
  constructor(private readonly client: Pick<IoTDataPlaneClient, "send">) {}

  /**
   * Publishes one payload at QoS 1. A payload above the MQTT limit the robot accepts is refused before the call, so the
   * robot never receives a message it would drop silently.
   *
   * @param topic - The command topic of the robot.
   * @param payload - The serialised command.
   * @throws When the payload is too large or the publish fails. The caller answers `upstream-failed`.
   */
  async publish(topic: string, payload: string): Promise<void> {
    const bytes = Buffer.from(payload, "utf8");
    if (bytes.byteLength > MAX_MQTT_PAYLOAD_BYTES) {
      throw new Error("command payload exceeds the MQTT limit");
    }
    await this.client.send(new PublishCommand({ topic, qos: 1, payload: bytes }));
  }
}
