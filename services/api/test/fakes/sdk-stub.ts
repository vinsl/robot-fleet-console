/**
 * Stand-in for the AWS SDK clients in the adapter tests.
 *
 * The adapters use nothing of a client but `send`, so a stub that records the commands sent and answers
 * with the outputs or errors a test scripts is enough. The asserted commands are the exact input the
 * adapter builds, which is what the AWS API receives.
 */
import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { IoTClient } from "@aws-sdk/client-iot";
import type { IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import type { KinesisVideoClient } from "@aws-sdk/client-kinesis-video";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { vi } from "vitest";

/** The mocked `send` of a stub: it takes one command and resolves with the scripted output. */
export type SendMock = ReturnType<typeof vi.fn<(command: unknown) => Promise<unknown>>>;

/**
 * @returns A fresh `send` mock with no scripted answer.
 */
export function sendStub(): SendMock {
  return vi.fn<(command: unknown) => Promise<unknown>>();
}

/**
 * @param send - The mock of a stub.
 * @returns The commands sent through it, in order.
 */
export function sentCommands(send: SendMock): unknown[] {
  return send.mock.calls.map(([command]) => command);
}

/*
 * The casts below are confined to this file. Each stub has only `send`, and each adapter calls nothing
 * else, so the type the adapter expects is the one a stub stands for.
 */

/**
 * @param send - The mock to expose as the DynamoDB document client.
 * @returns The stub, typed as the client.
 */
export function documentClientStub(send: SendMock): Pick<DynamoDBDocumentClient, "send"> {
  return { send };
}

/**
 * @param send - The mock to expose as the API Gateway management client.
 * @returns The stub, typed as the client.
 */
export function managementClientStub(send: SendMock): Pick<ApiGatewayManagementApiClient, "send"> {
  return { send };
}

/**
 * @param send - The mock to expose as an IoT control-plane client.
 * @returns The stub, typed as the client.
 */
export function iotClientStub(send: SendMock): Pick<IoTClient, "send"> {
  return { send };
}

/**
 * @param send - The mock to expose as the IoT data-plane client.
 * @returns The stub, typed as the client.
 */
export function iotDataClientStub(send: SendMock): Pick<IoTDataPlaneClient, "send"> {
  return { send };
}

/**
 * @param send - The mock to expose as the Kinesis Video client.
 * @returns The stub, typed as the client.
 */
export function kinesisClientStub(send: SendMock): Pick<KinesisVideoClient, "send"> {
  return { send };
}
