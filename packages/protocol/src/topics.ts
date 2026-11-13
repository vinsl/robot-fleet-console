/**
 * MQTT topic grammar of the fleet: builders for the publisher side and a parser for the subscriber side.
 *
 * Robots publish telemetry, events and acks through IoT topic rules, so their topics start with the
 * `$aws/rules/<rule>/` prefix. The cloud subscribes to the source filters of those rules and publishes
 * commands on a plain topic. The parser accepts both forms because the broker's handling of the
 * prefix in `topic()` is not documented for every case.
 */
import { RULE_NAMES } from "./constants";
import { RobotIdSchema, SiteIdSchema } from "./ids";

/** Channel a fleet topic belongs to. `cmd` is the cloud-to-robot direction, `ack` the robot's answer. */
export type FleetChannel = "telemetry" | "events" | "cmd" | "ack";

/** Identity and channel extracted from a fleet topic. */
export interface FleetTopic {
  readonly siteId: string;
  readonly robotId: string;
  readonly channel: FleetChannel;
}

/**
 * Matches a fleet topic with its optional rule prefix. Capture groups: 1 the rule name (absent on the
 * command topic), 2 site, 3 robot, 4 the channel segments.
 *
 * The rule names are spelled out here and not read from `RULE_NAMES`, because a pattern built at run
 * time is not checked by the linter; the round-trip tests fail if the two ever disagree. Anchored at
 * both ends, and every id segment is restricted to the identifier alphabet, so no wildcard, uppercase
 * letter or extra level can match.
 */
const FLEET_TOPIC_PATTERN =
  /^(?:\$aws\/rules\/(mfc_demo_telemetry|mfc_demo_events|mfc_demo_acks)\/)?fleet\/([a-z0-9-]{3,32})\/([a-z0-9-]{3,32})\/(telemetry|events|cmd\/ack|cmd)$/;

/** Channel carried by each rule. A rule topic that names a different channel is refused. */
const RULE_CHANNELS: ReadonlyMap<string, FleetChannel> = new Map<string, FleetChannel>([
  [RULE_NAMES.telemetry, "telemetry"],
  [RULE_NAMES.events, "events"],
  [RULE_NAMES.acks, "ack"],
]);

/**
 * Channel named by a channel segment. The pattern admits only the four segments below, so the last
 * one is the command topic.
 *
 * @param segment - The channel segment, already matched by {@link FLEET_TOPIC_PATTERN}.
 * @returns The channel the segment names.
 */
function channelOfSegment(segment: string): FleetChannel {
  switch (segment) {
    case "telemetry":
      return "telemetry";
    case "events":
      return "events";
    case "cmd/ack":
      return "ack";
    default:
      return "cmd";
  }
}

/**
 * Validates both identifiers of a topic before building it.
 *
 * @throws TypeError If the site or robot identifier is not valid.
 */
function assertIds(siteId: string, robotId: string): void {
  if (!SiteIdSchema.safeParse(siteId).success) {
    throw new TypeError("invalid site id");
  }
  if (!RobotIdSchema.safeParse(robotId).success) {
    throw new TypeError("invalid robot id");
  }
}

/**
 * Topic a robot publishes its telemetry on, through the telemetry rule.
 *
 * @throws TypeError If an identifier is not valid.
 */
export function telemetryTopic(siteId: string, robotId: string): string {
  assertIds(siteId, robotId);
  return `$aws/rules/${RULE_NAMES.telemetry}/fleet/${siteId}/${robotId}/telemetry`;
}

/**
 * Topic a robot publishes its events on, through the events rule.
 *
 * @throws TypeError If an identifier is not valid.
 */
export function eventsTopic(siteId: string, robotId: string): string {
  assertIds(siteId, robotId);
  return `$aws/rules/${RULE_NAMES.events}/fleet/${siteId}/${robotId}/events`;
}

/**
 * Topic a robot publishes its command acknowledgements on, through the acks rule.
 *
 * @throws TypeError If an identifier is not valid.
 */
export function ackTopic(siteId: string, robotId: string): string {
  assertIds(siteId, robotId);
  return `$aws/rules/${RULE_NAMES.acks}/fleet/${siteId}/${robotId}/cmd/ack`;
}

/**
 * Topic the cloud publishes commands on for one robot.
 *
 * @throws TypeError If an identifier is not valid.
 */
export function commandTopic(siteId: string, robotId: string): string {
  assertIds(siteId, robotId);
  return `fleet/${siteId}/${robotId}/cmd`;
}

/**
 * Source filter of a rule's SQL statement: the topics the rule reads, with wildcards for site and robot.
 *
 * @param kind - The stream the rule forwards.
 * @returns The MQTT topic filter used in the rule's `FROM` clause.
 */
export function ruleSourceFilter(kind: "telemetry" | "events" | "acks"): string {
  switch (kind) {
    case "telemetry":
      return "fleet/+/+/telemetry";
    case "events":
      return "fleet/+/+/events";
    case "acks":
      return "fleet/+/+/cmd/ack";
  }
}

/**
 * Parses a topic received from the broker. The input is untrusted, so the function never throws.
 *
 * A rule prefix, when present, must be a known rule and must match the channel it carries: a
 * telemetry topic that claims to come from the events rule is refused rather than trusted.
 *
 * @param topic - The topic string as received.
 * @returns The identity and channel, or `null` if the topic is not a well-formed fleet topic.
 */
export function parseFleetTopic(topic: string): FleetTopic | null {
  const match = FLEET_TOPIC_PATTERN.exec(topic);
  if (match === null) {
    return null;
  }
  const [, rule, siteId, robotId, segment] = match;
  // The compiler types every capture group as possibly absent. The pattern makes the three mandatory
  // groups present whenever it matches, so an absent one is treated as a refusal, never trusted.
  if (siteId === undefined || robotId === undefined || segment === undefined) {
    return null;
  }
  const channel = channelOfSegment(segment);
  if (rule !== undefined && RULE_CHANNELS.get(rule) !== channel) {
    return null;
  }
  return { siteId, robotId, channel };
}
