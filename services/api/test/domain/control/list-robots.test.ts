/**
 * Use case `listRobots`: summaries only, so no certificate, channel or provisioning field leaves the domain.
 */
import { RobotListResponseSchema, RobotSummarySchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { listRobots } from "../../../src/domain/control/list-robots";
import { CONTROL_ROBOT, CONTROL_SITE, controlWorld, robotOf } from "../../fakes/control";

describe("listRobots", () => {
  it("list-robots-summaries-only", async () => {
    const world = controlWorld();
    world.robots.records.set(
      "sim-05",
      robotOf("sim-05", {
        certificates: [
          {
            certificateId: "a".repeat(64),
            certificateArn: `arn:aws:iot:eu-west-3:123456789012:cert/${"a".repeat(64)}`,
          },
        ],
        kvsChannelArn:
          "arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-sim-05/1700000000000",
        failedStep: undefined,
      }),
    );
    const result = await listRobots(world.deps, CONTROL_SITE);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed = RobotListResponseSchema.parse(result.value);
    expect(parsed.robots.map((robot) => robot.robotId).sort()).toEqual(
      ["kali-01", CONTROL_ROBOT, "sim-05"].sort(),
    );
    for (const robot of parsed.robots) {
      expect(RobotSummarySchema.safeParse(robot).success).toBe(true);
      expect(Object.keys(robot)).not.toContain("certificates");
      expect(Object.keys(robot)).not.toContain("kvsChannelArn");
      expect(Object.keys(robot)).not.toContain("thingName");
    }
    expect(JSON.stringify(parsed)).not.toContain("arn:aws");
  });

  it("an empty site lists nothing", async () => {
    const world = controlWorld();
    world.robots.records.clear();
    const result = await listRobots(world.deps, CONTROL_SITE);

    expect(result).toEqual({ ok: true, value: { robots: [] } });
  });
});
