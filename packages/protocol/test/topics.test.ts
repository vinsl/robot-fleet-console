/**
 * Topic grammar: the shared vectors, the builders, and the refusal of every malformed input.
 */
import { describe, expect, it } from "vitest";
import {
  ackTopic,
  commandTopic,
  eventsTopic,
  parseFleetTopic,
  ruleSourceFilter,
  telemetryTopic,
} from "../src/index";
import { TOPIC_VECTORS } from "../scripts/topic-vectors";

describe("parseFleetTopic vectors", () => {
  for (const vector of TOPIC_VECTORS) {
    it(`maps ${JSON.stringify(vector.topic)} to ${JSON.stringify(vector.expected)}`, () => {
      expect(parseFleetTopic(vector.topic)).toEqual(vector.expected);
    });
  }
});

describe("topic builders", () => {
  it("builds the rule topics with the rule prefix and the topic grammar", () => {
    expect(telemetryTopic("paris-01", "kali-01")).toBe(
      "$aws/rules/mfc_demo_telemetry/fleet/paris-01/kali-01/telemetry",
    );
    expect(eventsTopic("paris-01", "kali-01")).toBe(
      "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events",
    );
    expect(ackTopic("paris-01", "kali-01")).toBe(
      "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
    );
  });

  it("builds the command topic without a rule prefix", () => {
    expect(commandTopic("paris-01", "kali-01")).toBe("fleet/paris-01/kali-01/cmd");
  });

  it.each([
    ["telemetry", () => telemetryTopic("paris-01", "kali-01"), "telemetry"],
    ["events", () => eventsTopic("paris-01", "kali-01"), "events"],
    ["ack", () => ackTopic("paris-01", "kali-01"), "ack"],
    ["command", () => commandTopic("paris-01", "kali-01"), "cmd"],
  ] as const)("round-trips the %s topic through the parser", (_name, build, channel) => {
    expect(parseFleetTopic(build())).toEqual({
      siteId: "paris-01",
      robotId: "kali-01",
      channel,
    });
  });

  it.each([
    ["wildcard in the site", "paris-+", "kali-01"],
    ["wildcard in the robot", "paris-01", "kali-#"],
    ["uppercase robot", "paris-01", "Kali-01"],
    ["two-character robot", "paris-01", "ka"],
    ["robot of 33 characters", "paris-01", "a".repeat(33)],
    ["empty site", "", "kali-01"],
    ["slash inside the robot", "paris-01", "kali/01"],
  ])("refuses an invalid identifier: %s", (_label, siteId, robotId) => {
    expect(() => telemetryTopic(siteId, robotId)).toThrow(TypeError);
    expect(() => eventsTopic(siteId, robotId)).toThrow(TypeError);
    expect(() => ackTopic(siteId, robotId)).toThrow(TypeError);
    expect(() => commandTopic(siteId, robotId)).toThrow(TypeError);
  });

  it("never echoes the rejected identifier in the error message", () => {
    expect(() => telemetryTopic("paris-01", "kali/#")).toThrow(/^invalid robot id$/);
  });
});

describe("ruleSourceFilter", () => {
  it.each([
    ["telemetry", "fleet/+/+/telemetry"],
    ["events", "fleet/+/+/events"],
    ["acks", "fleet/+/+/cmd/ack"],
  ] as const)("returns the source filter of the %s rule", (kind, filter) => {
    expect(ruleSourceFilter(kind)).toBe(filter);
  });

  it("is refused by the parser, so a wildcard filter can never be read as an identity", () => {
    expect(parseFleetTopic(ruleSourceFilter("telemetry"))).toBeNull();
    expect(parseFleetTopic(ruleSourceFilter("events"))).toBeNull();
    expect(parseFleetTopic(ruleSourceFilter("acks"))).toBeNull();
  });
});
