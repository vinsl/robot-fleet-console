/**
 * Live state over DynamoDB: the observation and presence conditions, the outcomes of a refused write, the
 * goodbye rule, and the site listing. The stub records the commands, so the test asserts the exact input the
 * AWS API receives.
 */
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbFleetState } from "../../src/adapters/dynamodb-fleet-state";
import type { StateObservation } from "../../src/domain/live/ports";
import type { Clock } from "../../src/domain/ports";
import { awsError } from "../fakes/call-gate";
import { documentClientStub, sendStub, sentCommands } from "../fakes/sdk-stub";
import { BOOT_A, BOOT_B } from "../fakes/live";

const TABLE = "mfc-demo-fleet";
const SITE = "paris-01";
const ROBOT = "kali-01";
const CLOCK: Clock = { now: () => new Date("2026-11-02T10:00:00.000Z") };

/** The condition of an observation, as reviewed. Changing it is a change of the ordering rule. */
const OBSERVE_CONDITION =
  "(attribute_not_exists(pk) OR attribute_not_exists(bootId) OR bootId < :boot OR (bootId = :boot AND seq < :seq)) AND (attribute_not_exists(offlineAtMs) OR offlineAtMs < :recv)";

/** A telemetry observation with every optional field present. */
const FULL: StateObservation = {
  siteId: SITE,
  robotId: ROBOT,
  bootId: BOOT_A,
  seq: 42,
  ts: "2026-11-02T10:00:00.000Z",
  receivedAt: 1_793_595_600_123,
  source: "telemetry",
  state: "MOVING",
  battery: 81.5,
  pose: { x: 12.5, y: -3.25, heading: 1.57, speed: 0.8 },
  missionId: "m-0042",
};

/**
 * The last command sent, as an update.
 *
 * @param send - The stub.
 * @returns The update input.
 */
function lastUpdate(send: ReturnType<typeof sendStub>): UpdateCommandInput {
  const command = sentCommands(send).at(-1);
  expect(command).toBeInstanceOf(UpdateCommand);
  return (command as UpdateCommand).input;
}

describe("DynamoDbFleetState.observe", () => {
  it("writes the observation under the reviewed condition, with every attribute as a placeholder", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).resolves.toBe("APPLIED");

    const input = lastUpdate(send);
    expect(input).toMatchObject({
      TableName: TABLE,
      Key: { pk: "SITE#paris-01", sk: "STATE#kali-01" },
      ConditionExpression: OBSERVE_CONDITION,
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":boot": BOOT_A,
      ":seq": 42,
      ":recv": 1_793_595_600_123,
      ":v_battery": 81.5,
      ":v_x": 12.5,
      ":v_missionId": "m-0042",
    });
    expect(input.UpdateExpression).toMatch(/^SET .* REMOVE #errorCode$/);
    expect(input.ExpressionAttributeNames).toMatchObject({
      "#state": "state",
      "#bootId": "bootId",
    });
  });

  it("removes the mission and the fault when the sample carries none, and keeps the pose when absent", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await state.observe({
      ...FULL,
      source: "event",
      battery: undefined,
      pose: undefined,
      missionId: undefined,
    });

    const input = lastUpdate(send);
    expect(input.UpdateExpression).toMatch(/ REMOVE #missionId, #errorCode$/);
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":v_x");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":v_battery");
  });

  it("reports a refused write as STALE when the store returns no item", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).resolves.toBe("STALE");
  });

  it("reports BEFORE_OFFLINE when the stored item was marked OFFLINE at or after the receive time", async () => {
    const send = sendStub();
    const error = Object.assign(awsError("ConditionalCheckFailedException"), {
      Item: { offlineAtMs: 1_793_595_600_123, bootId: BOOT_A },
    });
    send.mockRejectedValue(error);
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).resolves.toBe("BEFORE_OFFLINE");
  });

  it("reports STALE_BOOT when the stored sample belongs to a later boot", async () => {
    const send = sendStub();
    const error = Object.assign(awsError("ConditionalCheckFailedException"), {
      Item: { offlineAtMs: 1000, bootId: BOOT_B },
    });
    send.mockRejectedValue(error);
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).resolves.toBe("STALE_BOOT");
  });

  it("reports STALE, not STALE_BOOT, when the stored sample is of the same boot with a greater sequence", async () => {
    const send = sendStub();
    const error = Object.assign(awsError("ConditionalCheckFailedException"), {
      Item: { bootId: BOOT_A, seq: 99 },
    });
    send.mockRejectedValue(error);
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).resolves.toBe("STALE");
  });

  it("rethrows an infrastructure error", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ProvisionedThroughputExceededException"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.observe(FULL)).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("DynamoDbFleetState presence writes", () => {
  it("marks OFFLINE by the version when the broker supplies one, keeping the upsert", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    const outcome = await state.markOffline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: 9 });

    expect(outcome).toBe("APPLIED");
    const input = lastUpdate(send);
    expect(input.ConditionExpression).toBe(
      "attribute_not_exists(presenceVersion) OR presenceVersion < :version",
    );
    expect(input.ExpressionAttributeValues).toStrictEqual({
      ":v_state": "OFFLINE",
      ":v_offlineAtMs": 5,
      ":v_siteId": SITE,
      ":v_robotId": ROBOT,
      ":v_updatedBy": "presence",
      ":v_presenceVersion": 9,
      ":version": 9,
    });
  });

  it("marks OFFLINE by the time of the event when there is no version, with no unused placeholder", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await state.markOffline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: undefined });

    const input = lastUpdate(send);
    expect(input.ConditionExpression).toBe(
      "attribute_not_exists(offlineAtMs) OR offlineAtMs < :at",
    );
    expect(input.ExpressionAttributeValues).toHaveProperty(":at", 5);
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":version");
  });

  it("reports a refused OFFLINE mark as STALE", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markOffline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: 8 }),
    ).resolves.toBe("STALE");
  });

  it("records a connection only for a robot that has a live item, and never changes its state", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markOnline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: 10 }),
    ).resolves.toBe("APPLIED");

    const input = lastUpdate(send);
    expect(input.ConditionExpression).toBe(
      "attribute_exists(pk) AND (attribute_not_exists(presenceVersion) OR presenceVersion < :version)",
    );
    expect(input.UpdateExpression).not.toContain("#state");
  });

  it("uses the time condition for a connection without a version", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markOnline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: undefined }),
    ).resolves.toBe("STALE");
    expect(lastUpdate(send).ConditionExpression).toBe(
      "attribute_exists(pk) AND (attribute_not_exists(offlineAtMs) OR offlineAtMs < :at)",
    );
  });

  it("rethrows an infrastructure error of a presence write", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("InternalServerError"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markOnline({ siteId: SITE, robotId: ROBOT, atMs: 5, version: 1 }),
    ).rejects.toThrow();
  });
});

describe("DynamoDbFleetState goodbyes", () => {
  it("records the goodbye for the boot of an existing item", async () => {
    const send = sendStub();
    send.mockResolvedValue({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await state.markGoodbye({ siteId: SITE, robotId: ROBOT, bootId: BOOT_A });

    expect(lastUpdate(send)).toMatchObject({
      UpdateExpression: "SET goodbyeBootId = :boot",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(bootId) OR bootId = :boot)",
    });
  });

  it("accepts a goodbye that the condition refuses (no live item, or another boot) without an error", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markGoodbye({ siteId: SITE, robotId: ROBOT, bootId: BOOT_A }),
    ).resolves.toBeUndefined();
  });

  it("rethrows an infrastructure error of a goodbye", async () => {
    const send = sendStub();
    send.mockRejectedValue(awsError("InternalServerError"));
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(
      state.markGoodbye({ siteId: SITE, robotId: ROBOT, bootId: BOOT_A }),
    ).rejects.toThrow();
  });

  it("reads the stored boot and the goodbye boot, each undefined when absent", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: { bootId: BOOT_A, goodbyeBootId: BOOT_A } });
    send.mockResolvedValueOnce({});
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.readGoodbye(SITE, ROBOT)).resolves.toStrictEqual({
      bootId: BOOT_A,
      goodbyeBootId: BOOT_A,
    });
    await expect(state.readGoodbye(SITE, ROBOT)).resolves.toStrictEqual({
      bootId: undefined,
      goodbyeBootId: undefined,
    });
    expect(sentCommands(send)[0]).toBeInstanceOf(GetCommand);
  });
});

describe("DynamoDbFleetState listing and claims", () => {
  it("lists the complete live states of a site, skipping items without a sample", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Items: [
        {
          pk: "SITE#paris-01",
          sk: "STATE#kali-01",
          siteId: SITE,
          robotId: ROBOT,
          state: "MOVING",
          battery: 81.5,
          x: 12.5,
          y: -3.25,
          heading: 1.57,
          speed: 0.8,
          bootId: BOOT_A,
          seq: 42,
          ts: "2026-11-02T10:00:00.000Z",
          receivedAt: 1_793_595_600_123,
          writtenAt: 1,
          updatedBy: "telemetry",
        },
        {
          pk: "SITE#paris-01",
          sk: "STATE#sim-01",
          siteId: SITE,
          robotId: "sim-01",
          state: "OFFLINE",
        },
      ],
    });
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    const listed = await state.listSite(SITE);

    expect(listed).toStrictEqual([
      {
        robotId: ROBOT,
        siteId: SITE,
        state: "MOVING",
        battery: 81.5,
        pose: { x: 12.5, y: -3.25, heading: 1.57, speed: 0.8 },
        missionId: undefined,
        errorCode: undefined,
        bootId: BOOT_A,
        seq: 42,
        ts: "2026-11-02T10:00:00.000Z",
        receivedAt: 1_793_595_600_123,
      },
    ]);
    const query = sentCommands(send)[0];
    expect(query).toBeInstanceOf(QueryCommand);
    expect((query as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": "SITE#paris-01", ":prefix": "STATE#" },
    });
  });

  it("leaves out the last sample of a retired robot, read from the registry rows", async () => {
    const send = sendStub();
    const sample = (robotId: string) => ({
      pk: "SITE#paris-01",
      sk: `STATE#${robotId}`,
      siteId: SITE,
      robotId,
      state: "MOVING",
      battery: 81.5,
      x: 12.5,
      y: -3.25,
      heading: 1.57,
      speed: 0.8,
      bootId: BOOT_A,
      seq: 42,
      ts: "2026-11-02T10:00:00.000Z",
      receivedAt: 1_793_595_600_123,
      writtenAt: 1,
      updatedBy: "telemetry",
    });
    send.mockResolvedValueOnce({ Items: [sample("sim-01"), sample("probe-01")] });
    send.mockResolvedValueOnce({
      Items: [
        { sk: "ROBOT#sim-01", status: "ACTIVE" },
        { sk: "ROBOT#probe-01", status: "RETIRED" },
      ],
    });
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    const listed = await state.listSite(SITE);

    expect(listed.map((item) => item.robotId)).toStrictEqual(["sim-01"]);
    const registryQuery = sentCommands(send)[1];
    expect((registryQuery as QueryCommand).input).toMatchObject({
      ExpressionAttributeValues: { ":pk": "SITE#paris-01", ":prefix": "ROBOT#" },
      ProjectionExpression: "sk, #status",
    });
  });

  it("reads at most three pages of a site", async () => {
    const send = sendStub();
    send.mockResolvedValue({ Items: [], LastEvaluatedKey: { pk: "SITE#paris-01" } });
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await state.listSite(SITE);

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("refuses a stored sample that breaks the protocol rules, rather than serving it", async () => {
    const send = sendStub();
    send.mockResolvedValue({
      Items: [
        {
          pk: "SITE#paris-01",
          sk: "STATE#kali-01",
          robotId: ROBOT,
          siteId: SITE,
          state: "FLYING",
          battery: 1,
          bootId: BOOT_A,
          seq: 1,
          ts: "2026-11-02T10:00:00.000Z",
          receivedAt: 1,
        },
      ],
    });
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.listSite(SITE)).rejects.toThrow();
  });

  it("returns the site of a claimed robot, and null for an unclaimed or malformed one", async () => {
    const send = sendStub();
    send.mockResolvedValueOnce({ Item: { siteId: SITE } });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({ Item: { siteId: "BAD SITE" } });
    const state = new DynamoDbFleetState(documentClientStub(send), TABLE, CLOCK);

    await expect(state.siteOf(ROBOT)).resolves.toBe(SITE);
    await expect(state.siteOf(ROBOT)).resolves.toBeNull();
    await expect(state.siteOf(ROBOT)).resolves.toBeNull();
  });
});
