"""Protocol constants, mirrored from `packages/protocol/src/constants.ts`.

The parity test compares every value with the generated `constants.json`, so a change on one side
without the other fails the build rather than the robot.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

SCHEMA_VERSION: Final = "1.0.0"
SCHEMA_MAJOR: Final = 1
COMMAND_MAX_AGE_MS: Final = 2000
COMMAND_MAX_FUTURE_SKEW_MS: Final = 1000
REPLAY_LRU_SIZE: Final = 1000
DEADMAN_TIMEOUT_MS: Final = 1000
CONSOLE_HEARTBEAT_INTERVAL_MS: Final = 250
LOCK_IDLE_EXPIRY_MS: Final = 30000
ROBOT_HEARTBEAT_INTERVAL_MS: Final = 5000
OFFLINE_SILENCE_MS: Final = 15000
MAX_MQTT_PAYLOAD_BYTES: Final = 4096
REAL_TELEMETRY_HZ: Final = 2
SIM_TELEMETRY_MOVING_HZ: Final = 0.5
BATTERY_LOW_PERCENT: Final = 20
THING_NAME_PREFIX: Final = "mfc-demo-"
RULE_NAMES: Final = MappingProxyType(
    {
        "telemetry": "mfc_demo_telemetry",
        "events": "mfc_demo_events",
        "acks": "mfc_demo_acks",
        "presence": "mfc_demo_presence",
    }
)
"""Names of the IoT topic rules. Read-only, so that no caller can rename a rule at run time."""
ROLE_ALIAS_NAME: Final = "mfc-demo-robot-kvs-master"
ROBOT_POLICY_NAME: Final = "mfc-demo-robot"

LOCK_REQUIRED_COMMANDS: Final = (
    "PAUSE",
    "RESUME",
    "RETURN_TO_BASE",
    "ESTOP_RELEASE",
    "RELEASE_CONTROL",
    "HEARTBEAT",
    "DRIVE",
)
"""Commands that need the robot lock held by the sender, in the order of the generated constants."""

LOCK_FREE_COMMANDS: Final = ("ESTOP", "TAKE_CONTROL", "SIMULATE_FAULT")
"""Commands accepted without the lock."""

UNSUPPORTED_COMMANDS: Final = ("DRIVE",)
"""Commands the schema accepts but the robot refuses with `INVALID`."""
