/**
 * Construction of the AWS SDK clients of the API functions.
 *
 * Every client gets the same attempts and timeouts, so a slow dependency fails one invocation quickly instead
 * of holding it until the function timeout. Constructing a client makes no call. The X-Ray tracer wraps the
 * clients the handler passes in; the management client is wrapped the same way.
 */
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import type { AwsRegion } from "@mfc/protocol";

/** Attempts per SDK call, for the DynamoDB client. */
const DYNAMO_MAX_ATTEMPTS = 3;

/** Attempts per management call. A push that still fails is counted, not retried more than once. */
const MANAGEMENT_MAX_ATTEMPTS = 2;

/** Time the DynamoDB client waits for a response, in milliseconds. */
const DYNAMO_REQUEST_TIMEOUT_MS = 5000;

/** Time the management client waits for a response, in milliseconds. A slow push must not hold the fan-out. */
const MANAGEMENT_REQUEST_TIMEOUT_MS = 2000;

/** Time either client waits for a connection to open, in milliseconds. */
const CONNECTION_TIMEOUT_MS = 1000;

/**
 * Builds the DynamoDB document client of a function, traced. Empty attributes are dropped on write, so an
 * optional field that is absent is simply not stored.
 *
 * @param region - The region of the stack.
 * @param tracer - The tracer of the function.
 * @returns The document client.
 */
export function createDynamoDocumentClient(
  region: AwsRegion,
  tracer: Tracer,
): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region,
    maxAttempts: DYNAMO_MAX_ATTEMPTS,
    requestHandler: {
      requestTimeout: DYNAMO_REQUEST_TIMEOUT_MS,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    },
  });
  return DynamoDBDocumentClient.from(tracer.captureAWSv3Client(client), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Builds the S3 client of a function, traced. The same attempts and timeouts as the other clients apply, so a
 * slow object read fails one invocation quickly.
 *
 * @param region - The region of the stack.
 * @param tracer - The tracer of the function.
 * @returns The S3 client.
 */
export function createS3Client(region: AwsRegion, tracer: Tracer): S3Client {
  return tracer.captureAWSv3Client(
    new S3Client({
      region,
      maxAttempts: DYNAMO_MAX_ATTEMPTS,
      requestHandler: {
        requestTimeout: DYNAMO_REQUEST_TIMEOUT_MS,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
      },
    }),
  );
}

/**
 * Builds the management client of one WebSocket stage. The endpoint is validated by the environment schema.
 *
 * @param endpoint - The HTTPS endpoint of the stage.
 * @param region - The region of the stage, used to sign the requests.
 * @returns The client; it makes no call until used.
 */
export function createManagementClient(
  endpoint: string,
  region: AwsRegion,
): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({
    endpoint,
    region,
    maxAttempts: MANAGEMENT_MAX_ATTEMPTS,
    requestHandler: {
      requestTimeout: MANAGEMENT_REQUEST_TIMEOUT_MS,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    },
  });
}
