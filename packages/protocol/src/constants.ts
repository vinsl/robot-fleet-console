/**
 * Protocol constants shared by the console, the API and the robot agent.
 *
 * Every value that a safety rule, a replay window or a timeout depends on lives here, so that the
 * TypeScript and Python sides are checked against the same numbers (the generated
 * `constants.json` is compared by the agent's parity tests).
 */

/** Full protocol schema version written in every envelope. Consumers accept any minor of the major below. */
export const SCHEMA_VERSION = "1.0.0";

/** Major version of the protocol. A message with another major is rejected, never partially read. */
export const SCHEMA_MAJOR = 1;

/**
 * Commands older than this, measured against the robot wall clock, are rejected with `EXPIRED`.
 * Two seconds bounds how long a captured command stays usable by a replay attacker.
 */
export const COMMAND_MAX_AGE_MS = 2000;

/**
 * Commands issued this far in the future are rejected too. A small tolerance absorbs clock skew
 * between the cloud and the robot without accepting commands dated arbitrarily ahead.
 */
export const COMMAND_MAX_FUTURE_SKEW_MS = 1000;

/**
 * Number of command identifiers the robot remembers per boot. It must cover every replay that is
 * still inside the age window at the broker's publish rate (see the invariant test).
 */
export const REPLAY_LRU_SIZE = 1000;

/** Motion stops if the console has not refreshed the lock for this long while the robot moves. */
export const DEADMAN_TIMEOUT_MS = 1000;

/** Interval at which the console sends `HEARTBEAT` while it holds the robot lock. */
export const CONSOLE_HEARTBEAT_INTERVAL_MS = 250;

/** A lock with no activity for this long is considered abandoned and may be taken over. */
export const LOCK_IDLE_EXPIRY_MS = 30000;

/** Interval of the robot heartbeat event during silence, so that the cloud can tell a quiet robot from a dead one. */
export const ROBOT_HEARTBEAT_INTERVAL_MS = 5000;

/** The cloud marks a robot `OFFLINE` after this much silence, even if the broker did not report a disconnect. */
export const OFFLINE_SILENCE_MS = 15000;

/** Largest MQTT payload the robot parses. Larger payloads are dropped before any JSON parsing. */
export const MAX_MQTT_PAYLOAD_BYTES = 4096;

/** Telemetry rate of a real robot, in every state. */
export const REAL_TELEMETRY_HZ = 2;

/** Telemetry rate of a simulated robot while it moves. */
export const SIM_TELEMETRY_MOVING_HZ = 0.5;

/** Battery level below which the robot asks for a charge. */
export const BATTERY_LOW_PERCENT = 20;

/** Prefix of every IoT thing name. The thing name is the MQTT client id and the KVS channel name. */
export const THING_NAME_PREFIX = "mfc-demo-";

/** Names of the IoT topic rules. CI may only manage rules whose name starts with `mfc_demo_`. */
export const RULE_NAMES = {
  telemetry: "mfc_demo_telemetry",
  events: "mfc_demo_events",
  acks: "mfc_demo_acks",
  presence: "mfc_demo_presence",
} as const;

/** Name of the IoT role alias that gives a robot temporary KVS credentials. */
export const ROLE_ALIAS_NAME = "mfc-demo-robot-kvs-master";

/** Name of the single IoT policy attached to every robot certificate. */
export const ROBOT_POLICY_NAME = "mfc-demo-robot";
