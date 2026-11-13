/**
 * Push over the API Gateway management API: the three outcomes of a post, the swallowed close, and the logs
 * that carry the error name only, never the connection identifier.
 */
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { describe, expect, it } from "vitest";
import { ApiGatewayPush } from "../../src/adapters/apigw-push";
import { createDynamoDocumentClient, createManagementClient } from "../../src/adapters/clients";
import { awsError } from "../fakes/call-gate";
import { RecordingLogger } from "../fakes/recording";
import { managementClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";

const ENDPOINT = "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live";

describe("ApiGatewayPush.post", () => {
  it("sends the frame as UTF-8 to the connection and reports SENT", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const logger = new RecordingLogger();
    const push = new ApiGatewayPush(managementClientStub(send), logger);

    await expect(push.post("abcdef12", '{"type":"ping"}')).resolves.toBe("SENT");

    const command = sentCommands(send)[0];
    expect(command).toBeInstanceOf(PostToConnectionCommand);
    expect((command as PostToConnectionCommand).input.ConnectionId).toBe("abcdef12");
    expect((command as PostToConnectionCommand).input.Data).toStrictEqual(
      Buffer.from('{"type":"ping"}', "utf8"),
    );
  });

  it("reports GONE for a connection that no longer exists", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("GoneException"));
    const push = new ApiGatewayPush(managementClientStub(send), new RecordingLogger());

    await expect(push.post("abcdef12", "{}")).resolves.toBe("GONE");
  });

  it("reports FAILED for any other error, logging the name only", async () => {
    const send = sendStub();
    send.mockRejectedValue(
      Object.assign(awsError("LimitExceededException"), {
        message: "connection abcdef12 throttled",
      }),
    );
    const logger = new RecordingLogger();
    const push = new ApiGatewayPush(managementClientStub(send), logger);

    await expect(push.post("abcdef12", "{}")).resolves.toBe("FAILED");

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.message).toBe("push failed");
    expect(logger.text()).not.toContain("abcdef12");
  });
});

describe("ApiGatewayPush.close", () => {
  it("deletes the connection", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const push = new ApiGatewayPush(managementClientStub(send), new RecordingLogger());

    await push.close("abcdef12");

    expect(sentCommands(send)[0]).toBeInstanceOf(DeleteConnectionCommand);
  });

  it("swallows a connection that is already gone, without a log", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("GoneException"));
    const logger = new RecordingLogger();
    const push = new ApiGatewayPush(managementClientStub(send), logger);

    await expect(push.close("abcdef12")).resolves.toBeUndefined();
    expect(logger.entries).toStrictEqual([]);
  });

  it("swallows any other failure, logging its name", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("InternalServerError"));
    const logger = new RecordingLogger();
    const push = new ApiGatewayPush(managementClientStub(send), logger);

    await expect(push.close("abcdef12")).resolves.toBeUndefined();
    expect(logger.entries[0]?.message).toBe("connection close failed");
  });
});

describe("client factories", () => {
  it("builds the management client and the document client without any call", () => {
    const tracer = new Tracer({ serviceName: "test", enabled: false });

    expect(createManagementClient(ENDPOINT, "eu-west-3")).toBeInstanceOf(
      ApiGatewayManagementApiClient,
    );
    expect(createDynamoDocumentClient("eu-west-3", tracer)).toBeDefined();
  });
});
