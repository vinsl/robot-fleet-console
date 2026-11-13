/**
 * Input/output vectors of `parseFleetTopic`, shared by the TypeScript tests and the generated
 * `topic-vectors.json` that the Python agent checks its own parser against.
 *
 * The vectors are the contract: a change to the topic grammar must change them, and both languages
 * then fail until they agree.
 */
import type { FleetTopic } from "../src/topics";

/** One case: a topic as received, and the identity it must parse to (`null` when it must be refused). */
export interface TopicVector {
  readonly topic: string;
  readonly expected: FleetTopic | null;
}

/** Identity used by most vectors: the demo's real robot at the demo site. */
const KALI = { siteId: "paris-01", robotId: "kali-01" } as const;

/** Vectors accepted by `parseFleetTopic` and the refusals that matter most for safety. */
export const TOPIC_VECTORS: readonly TopicVector[] = [
  {
    topic: "$aws/rules/mfc_demo_telemetry/fleet/paris-01/kali-01/telemetry",
    expected: { ...KALI, channel: "telemetry" },
  },
  {
    topic: "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events",
    expected: { ...KALI, channel: "events" },
  },
  {
    topic: "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
    expected: { ...KALI, channel: "ack" },
  },
  { topic: "fleet/paris-01/kali-01/telemetry", expected: { ...KALI, channel: "telemetry" } },
  { topic: "fleet/paris-01/kali-01/cmd", expected: { ...KALI, channel: "cmd" } },
  {
    topic: "fleet/paris-01/sim-01/events",
    expected: { siteId: "paris-01", robotId: "sim-01", channel: "events" },
  },
  { topic: "fleet/+/+/telemetry", expected: null },
  { topic: "fleet/paris-01/#", expected: null },
  { topic: "fleet/paris-01/Kali-01/telemetry", expected: null },
  { topic: "fleet/paris-01/ka/telemetry", expected: null },
  { topic: "fleet/paris-01/kali-01/telemetry/extra", expected: null },
  { topic: "fleet/paris-01/kali-01/cmd/ack/extra", expected: null },
  { topic: "fleet//kali-01/telemetry", expected: null },
  { topic: "fleet/paris-01/kali-01/telemetry\n", expected: null },
  { topic: "fleet/paris-01/kali-01/telemetry?", expected: null },
  { topic: "fleet/paris-01/kali-01/cmd/telemetry", expected: null },
  { topic: "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/telemetry", expected: null },
  { topic: "$aws/rules/mfc_demo_telemetry/fleet/paris-01/kali-01/cmd", expected: null },
  { topic: "$aws/rules/other_rule/fleet/paris-01/kali-01/telemetry", expected: null },
  { topic: "$aws/rules/mfc_demo_telemetry/fleet/paris-01/kali-01", expected: null },
  { topic: "", expected: null },
];
