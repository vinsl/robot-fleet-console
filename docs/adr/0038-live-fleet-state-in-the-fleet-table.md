# ADR 0038 — Live robot state in the fleet table, ordered by (bootId, seq), with a persist policy

- Status: accepted
- Date: 2026-11-02
- Requirements: FR-ROB-3, FR-ROB-4, NFR-REL-1, NFR-COST-1
- Threats: T5 (out-of-order telemetry corrupts state), T32 (late samples revive an OFFLINE robot)
- Builds on ADR 0029 (the registry record in the fleet table) and ADR 0031 (rule deliveries).

## Context

The console needs a current state for every robot when it subscribes, and idle robots send only heartbeats, so the
state cannot come from telemetry alone. The fleet table already holds the registry record `ROBOT#<robotId>`, written
under a conditional `version` by the registration (ADR 0029). Live state written into that item would race with
registry writes. Robot clocks are not trusted, and a standard SQS queue does not keep order (ADR 0039), so the order of
samples has to come from the robot's own identifiers: `bootId` (a UUIDv7 created at each boot, so it sorts by time)
and `seq` (counted within a boot). Writing every telemetry sample of 20 robots at 0.5 Hz would cost about 10 write
units per second for a value that nothing reads.

## Decision

The live state of a robot is one item `STATE#<robotId>` in the partition `SITE#<siteId>` of the fleet table. Both
consumers write it through one port, `FleetStatePort.observe`: telemetry, and the heartbeat, boot and state events
(without pose).

- The write is a conditional `UpdateItem`. It applies when the stored item is absent, or its `bootId` is smaller, or
  its `bootId` is equal and its `seq` is smaller, and when the robot was not marked OFFLINE after the sample was
  received (`offlineAtMs` watermark). The write asks for the stored item on failure
  (`ReturnValuesOnConditionCheckFailure: ALL_OLD`), so the caller tells `STALE` (an equal or newer sample of the same
  boot is stored), `STALE_BOOT` (a sample of a later boot is stored, counted apart) and `BEFORE_OFFLINE`.
- Telemetry is persisted by a per-container `PersistPolicy`: a sample is written when the robot has no entry, when its
  boot, state or mission changed, or when 10 s (`LIVE_STATE_PERSIST_INTERVAL_MS`) passed since its last written sample.
  The policy keeps at most 1 000 robots and clears itself when full. Samples in between go to the WebSocket only.
- Presence writes do not compare `seq`. `markOffline` and `markOnline` are guarded by the `presenceVersion` of the
  broker notice, and `markOffline` creates the item when the robot never reported, so it still shows as OFFLINE.
- The boot identifier is refused before the write when it is dated more than 24 h after the broker received the
  message (`BOOT_IN_FUTURE`, THREAT_MODEL T31). A robot clock that runs behind its previous boot is refused as `STALE_BOOT`.

## Alternatives considered

| Option                          | Pros                     | Cons                                                           | Why not                                                     |
| ------------------------------- | ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Live state in the `ROBOT#` item | One item per robot       | Shares the write path and the `version` of the registry        | A registry write could fail or lose a live update           |
| Order by the robot's timestamp  | Simple comparison        | Robot clocks are not trusted, and a reboot can go back in time | `bootId` and `seq` are ordered by the robot itself          |
| Telemetry as the only writer    | One writer               | An idle robot after a reconnect stays OFFLINE until it moves   | Heartbeats and events carry the state too                   |
| Write every telemetry sample    | Simplest, always current | About 10 write units per second for 20 robots, read by nothing | The persist policy keeps the last state and a 10 s refresh  |
| A separate live-state table     | Isolated writes          | One more resource for the same access pattern                  | The partition of the fleet table already holds the registry |

## Consequences

- At 20 robots the state writes are at most about 2 per second (one per robot per 10 s), plus one write per change of
  state, boot or mission. A cold container writes the first sample of each robot, which is harmless.
- Ordering depends on the UUIDv7 `bootId`. A later boot always wins, and a sample of an earlier boot is never written
  over a later one. A robot clock that runs behind its previous boot is refused as `STALE_BOOT` and counted: the
  boot identifier is not repaired, the sample is dropped. Accepted, and counted by `StaleBootRefused`.
- The in-container memory is an optimisation only. The condition in DynamoDB decides, so a lost memory costs one
  extra write, never a wrong state.
- A robot that stays connected but stops publishing keeps its last stored state; only the console shows it OFFLINE
  after 15 s of silence (ADR 0040, THREAT_MODEL R46).
