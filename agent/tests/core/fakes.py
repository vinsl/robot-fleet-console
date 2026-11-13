"""Test doubles and builders of the core. They are deterministic, so every test controls time.

Only the doubles the tests use live here, and each one is exercised by a test. The transport fake
never completes an operation on its own: a test decides when a publish or a subscribe is
acknowledged, so the order of the outcomes is part of the scenario.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

from fleet_agent.core.agent import AgentCore, AgentIdentity
from fleet_agent.core.ids import uuid7
from fleet_agent.core.model import Point, RobotModel, SiteGeometry
from fleet_agent.core.ports import (
    LatchRecord,
    LatchUnreadableError,
    LatchWriteError,
    PublishOutcome,
    QoS,
    SubscribeOutcome,
    TransportListener,
)
from fleet_agent.core.screening import ScreeningContext
from fleet_agent.protocol.primitives import ReportedState
from fleet_agent.protocol.topics import ack_topic, command_topic, telemetry_topic
from fleet_agent.timefmt import format_iso_ms

WALL_ORIGIN_MS = 1_793_613_600_000
"""2026-11-02T10:00:00.000Z. A plausible wall time for a test, far from every edge of the format."""

ROBOT_ID = "kali-01"
SITE_ID = "paris-01"
LOCK_TOKEN = "lock-token-0123456789abcdef"  # noqa: S105 - a fixed fake token, not a credential
OPERATOR_SUB = "operator-sub-1"
COMMAND_TOPIC = command_topic(SITE_ID, ROBOT_ID)

SITE = SiteGeometry(
    charger=Point(0.0, 0.0),
    start=Point(10.0, 0.0),
    start_heading=0.0,
    speed_mps=1.0,
)
"""The site layout the tests share: the charger at the origin, the robot starting 10 m away."""

SCREENING = ScreeningContext(
    robot_id=ROBOT_ID,
    site_id=SITE_ID,
    simulated=False,
    command_topic=COMMAND_TOPIC,
)
"""The screening context of a real robot on the test topic."""

_PARAMS_BY_TYPE: dict[str, dict[str, object]] = {
    "DRIVE": {"linear": 0.0, "angular": 0.0, "durationMs": 100},
    "SIMULATE_FAULT": {"fault": "OBSTACLE"},
}


class FakeClock:
    """A clock that moves only when a test advances it.

    Both clocks move together: a test that advances the monotonic time expects the wall time to
    follow, as it does on a machine that is not stepped by NTP.
    """

    def __init__(self, mono: int = 0, wall: int = WALL_ORIGIN_MS) -> None:
        """Creates a clock at the given instants.

        Args:
            mono: The monotonic time, in milliseconds.
            wall: The wall-clock time, in milliseconds since the Unix epoch.
        """
        self._mono = mono
        self._wall = wall

    def monotonic_ms(self) -> int:
        """Returns the current monotonic time.

        Returns:
            The monotonic time, in milliseconds.
        """
        return self._mono

    def wall_ms(self) -> int:
        """Returns the current wall-clock time.

        Returns:
            The wall time, in milliseconds since the Unix epoch.
        """
        return self._wall

    def advance(self, ms: int) -> None:
        """Moves both clocks forward.

        Args:
            ms: The number of milliseconds to add. Must not be negative: the clocks are monotonic.

        Raises:
            ValueError: If `ms` is negative.
        """
        if ms < 0:
            raise ValueError("a fake clock only moves forward")
        self._mono += ms
        self._wall += ms


class MemoryLatchStore:
    """An in-memory e-stop latch whose failures are switched on by the test.

    Attributes:
        record: The stored record, or None when the latch is clear.
        set_calls: How many times `set` was called, whether or not it failed.
        clear_calls: How many times `clear` was called, whether or not it failed.
        fail_set: Whether `set` raises `LatchWriteError`. A test may switch it off mid-scenario.
        fail_clear: Whether `clear` raises `LatchWriteError`.
    """

    def __init__(
        self,
        *,
        latched: bool = False,
        fail_set: bool = False,
        fail_clear: bool = False,
        unreadable: bool = False,
    ) -> None:
        """Creates a store, latched or clear, with the given failures.

        Args:
            latched: Whether the latch starts set.
            fail_set: Whether `set` raises `LatchWriteError`.
            fail_clear: Whether `clear` raises `LatchWriteError`.
            unreadable: Whether `is_set` raises `LatchUnreadableError`.
        """
        self.record: LatchRecord | None = (
            LatchRecord(command_id=uuid7(), boot_id=uuid7(), latched_at="2026-11-02T09:00:00.000Z")
            if latched
            else None
        )
        self.set_calls = 0
        self.clear_calls = 0
        self.fail_set = fail_set
        self.fail_clear = fail_clear
        self._unreadable = unreadable

    def is_set(self) -> bool:
        """Tells whether the latch is set.

        Returns:
            True when a record is stored.

        Raises:
            LatchUnreadableError: When the store was built unreadable.
        """
        if self._unreadable:
            raise LatchUnreadableError("the latch cannot be read")
        return self.record is not None

    def set(self, record: LatchRecord) -> None:
        """Stores a record, unless the store was built to fail writes.

        Args:
            record: The record to store.

        Raises:
            LatchWriteError: When the store was built with `fail_set`.
        """
        self.set_calls += 1
        if self.fail_set:
            raise LatchWriteError("the latch cannot be written")
        self.record = record

    def clear(self) -> None:
        """Removes the record, unless the store was built to fail removals.

        Raises:
            LatchWriteError: When the store was built with `fail_clear`.
        """
        self.clear_calls += 1
        if self.fail_clear:
            raise LatchWriteError("the latch cannot be removed")
        self.record = None


def make_command(
    command_type: str,
    *,
    wall_ms: int = WALL_ORIGIN_MS,
    **overrides: object,
) -> dict[str, object]:
    """Builds a valid camelCase command for the test robot, with fresh identifiers.

    Args:
        command_type: The command type, for example `PAUSE`.
        wall_ms: The wall time the command is issued at, in milliseconds since the Unix epoch.
        **overrides: Camel-case fields to set or replace, for example `lockToken`.

    Returns:
        The command as a JSON-ready dictionary.
    """
    issued = format_iso_ms(wall_ms)
    command: dict[str, object] = {
        "schemaVersion": "1.0.0",
        "messageId": uuid7(now_ms=wall_ms),
        "robotId": ROBOT_ID,
        "siteId": SITE_ID,
        "ts": issued,
        "commandId": uuid7(now_ms=wall_ms),
        "issuedAt": issued,
        "issuedBy": OPERATOR_SUB,
        "correlationId": "corr-0123456789",
        "type": command_type,
        "params": dict(_PARAMS_BY_TYPE.get(command_type, {})),
    }
    command.update(overrides)
    return command


def make_model(state: ReportedState = "IDLE") -> RobotModel:
    """Builds a model at the site's start position, stationary and fully charged.

    Tests set the fields they need after construction, so the builder stays free of options.

    Args:
        state: The reported state of the model.

    Returns:
        The model.
    """
    return RobotModel(
        state=state,
        resume_target=None,
        x=SITE.start.x,
        y=SITE.start.y,
        heading=SITE.start_heading,
        speed=0.0,
        battery=100.0,
    )


class FakeTransport:
    """A transport that records the core's requests and completes them only when a test says so.

    Attributes:
        published: Every publish call, as (topic, payload, qos), in call order. The index of a
            publish is the index a test passes to `complete_publish`.
        subscriptions: Every topic filter subscribed to, in call order.
        suspended: Every duration the link was dropped for, in call order.
    """

    def __init__(self) -> None:
        """Creates a transport with nothing recorded and no listener."""
        self.published: list[tuple[str, bytes, QoS]] = []
        self.subscriptions: list[str] = []
        self.suspended: list[int] = []
        self._listener: TransportListener | None = None
        self._publish_callbacks: list[Callable[[PublishOutcome], None] | None] = []
        self._subscribe_callbacks: list[Callable[[SubscribeOutcome], None]] = []

    def set_listener(self, listener: TransportListener) -> None:
        """Registers the listener that receives inbound messages and connection events.

        Args:
            listener: The listener, replacing any previous one.
        """
        self._listener = listener

    def start(self) -> None:
        """Does nothing. The core never starts the transport; the runner does."""

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Records a publish, and keeps its completion callback until the test completes it.

        Args:
            topic: The topic published on.
            payload: The serialised message.
            qos: The requested quality of service.
            on_done: The completion callback, if the core gave one.
        """
        self.published.append((topic, payload, qos))
        self._publish_callbacks.append(on_done)

    def subscribe(self, topic_filter: str, on_done: Callable[[SubscribeOutcome], None]) -> None:
        """Records a subscribe, and keeps its completion callback until the test completes it.

        Args:
            topic_filter: The filter subscribed to.
            on_done: The completion callback.
        """
        self.subscriptions.append(topic_filter)
        self._subscribe_callbacks.append(on_done)

    def suspend(self, duration_ms: int) -> None:
        """Records a deliberate link drop.

        Args:
            duration_ms: How long the link was dropped for.
        """
        self.suspended.append(duration_ms)

    async def stop(self, timeout_s: float) -> None:
        """Does nothing. Only the runner stops the transport, and the core tests never run it.

        Args:
            timeout_s: Ignored.
        """

    def complete_publish(self, index: int, outcome: PublishOutcome) -> None:
        """Acknowledges the publish at `index` with the given outcome.

        Args:
            index: The position of the publish in `published`.
            outcome: The outcome the broker reported.

        Raises:
            AssertionError: If that publish had no completion callback to run.
        """
        callback = self._publish_callbacks[index]
        if callback is None:
            raise AssertionError("this publish has no completion callback")
        callback(outcome)

    def complete_subscribe(self, outcome: SubscribeOutcome, index: int = -1) -> None:
        """Answers a subscribe with the given SUBACK outcome.

        Args:
            outcome: The mapped SUBACK.
            index: The subscribe to answer. Defaults to the most recent one.
        """
        self._subscribe_callbacks[index](outcome)

    def deliver(self, topic: str, payload: bytes) -> None:
        """Delivers an inbound message to the listener, as the broker would.

        Args:
            topic: The topic the message arrives on.
            payload: The raw payload.

        Raises:
            AssertionError: If no listener was registered.
        """
        if self._listener is None:
            raise AssertionError("no listener is registered")
        self._listener.on_message(topic, payload)


def model_of(core: AgentCore) -> RobotModel:
    """Reads the robot model of a core, for the tests that have no public view of a field.

    The model is private on purpose: the core exposes no read access to it. A halt must zero the
    speed and clear the destination, and no public view shows either, so the tests read them here.
    Every other check goes through `snapshot`, the telemetry or the published events.

    Args:
        core: The core under test.

    Returns:
        The robot model.
    """
    model: RobotModel = core._model
    return model


def encode(message: dict[str, object]) -> bytes:
    """Serialises a test message the way the console sends it.

    Args:
        message: The message as a JSON-ready dictionary.

    Returns:
        The UTF-8 JSON body.
    """
    return json.dumps(message).encode("utf-8")


def body_of(transport: FakeTransport, index: int) -> dict[str, object]:
    """Decodes the payload of one publish, so a test can read its fields.

    Args:
        transport: The fake that recorded the publish.
        index: The position of the publish in `published`.

    Returns:
        The decoded JSON object.

    Raises:
        AssertionError: If the payload is not a JSON object.
    """
    _, payload, _ = transport.published[index]
    value: object = json.loads(payload)
    if not isinstance(value, dict):
        raise AssertionError("a published payload is always a JSON object")
    return value


def deliver(
    transport: FakeTransport,
    clock: FakeClock,
    command_type: str,
    *,
    wall_ms: int | None = None,
    **overrides: object,
) -> dict[str, object]:
    """Sends a command to the core as the broker would, and returns it.

    Args:
        transport: The fake that delivers the message.
        clock: The clock, whose wall time the command is issued at by default.
        command_type: The command type.
        wall_ms: The issue time, in milliseconds, when the test needs an old or future command.
        **overrides: Camel-case fields to set or replace.

    Returns:
        The command as sent.
    """
    command = make_command(
        command_type,
        wall_ms=clock.wall_ms() if wall_ms is None else wall_ms,
        **overrides,
    )
    transport.deliver(COMMAND_TOPIC, encode(command))
    return command


def field_of(record: logging.LogRecord, name: str) -> object:
    """Reads one allowlisted field of a captured log record.

    Args:
        record: The record captured by the log fixture.
        name: The camel-case field name.

    Returns:
        The value the core passed for that field.
    """
    return vars(record)[name]


def label_of(transport: FakeTransport, index: int) -> str:
    """Names the kind of one publish: a telemetry, an acknowledgement, or an event's kind.

    Args:
        transport: The fake that recorded the publish.
        index: The position of the publish in `published`.

    Returns:
        `TELEMETRY`, `ACK`, or the `kind` of the event (for example `STATE_CHANGED`).

    Raises:
        AssertionError: If an event payload carries no `kind`.
    """
    topic, _, _ = transport.published[index]
    if topic == telemetry_topic(SITE_ID, ROBOT_ID):
        return "TELEMETRY"
    if topic == ack_topic(SITE_ID, ROBOT_ID):
        return "ACK"
    kind = body_of(transport, index).get("kind")
    if not isinstance(kind, str):
        raise AssertionError("an event payload always names its kind")
    return kind


def labels(transport: FakeTransport) -> list[str]:
    """Names every publish in order, so a test can assert the whole output sequence at once.

    Args:
        transport: The fake that recorded the publishes.

    Returns:
        One label per publish, as `label_of` gives it.
    """
    return [label_of(transport, index) for index in range(len(transport.published))]


def build_core(
    *,
    simulated: bool = False,
    latch: MemoryLatchStore | None = None,
    battery_start: float = 80.0,
    rand: Callable[[], float] | None = None,
) -> tuple[AgentCore, FakeClock, FakeTransport, MemoryLatchStore]:
    """Builds an unbooted core wired to fakes, for the tests that exercise the boot itself.

    Args:
        simulated: Whether the robot is a simulator.
        latch: The latch store to use. A clear store is built when none is given.
        battery_start: The charge at boot, in percent.
        rand: The subscribe backoff draw source. A fixed midpoint when none is given.

    Returns:
        The core, its clock, its transport and its latch store.
    """
    clock = FakeClock()
    transport = FakeTransport()
    store = latch if latch is not None else MemoryLatchStore()
    identity = AgentIdentity(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        thing_name=f"mfc-demo-{ROBOT_ID}",
        simulated=simulated,
        agent_version="0.1.0",
    )
    core = AgentCore(
        identity=identity,
        geometry=SITE,
        battery_start=battery_start,
        clock=clock,
        transport=transport,
        latch=store,
        rand=rand if rand is not None else _midpoint,
    )
    transport.set_listener(core)
    return core, clock, transport, store


def make_core(
    *,
    simulated: bool = False,
    latched: bool = False,
    battery_start: float = 80.0,
    rand: Callable[[], float] | None = None,
) -> tuple[AgentCore, FakeClock, FakeTransport, MemoryLatchStore]:
    """Builds a core wired to fakes and boots it, so the first publish is the BOOT event.

    Args:
        simulated: Whether the robot is a simulator.
        latched: Whether the latch starts set, so that the boot lands in ESTOP.
        battery_start: The charge at boot, in percent.
        rand: The subscribe backoff draw source. A fixed midpoint when none is given.

    Returns:
        The booted core, its clock, its transport and its latch store.
    """
    store = MemoryLatchStore(latched=latched)
    core, clock, transport, _ = build_core(
        simulated=simulated, latch=store, battery_start=battery_start, rand=rand
    )
    core.boot()
    return core, clock, transport, store


def make_teleop() -> tuple[AgentCore, FakeClock, FakeTransport, MemoryLatchStore]:
    """Builds a booted core whose lock is held by the test operator, teleoperated in TELEOP.

    Returns:
        The core, its clock, its transport and its latch store.
    """
    core, clock, transport, latch = make_core()
    deliver(transport, clock, "TAKE_CONTROL", lockToken=LOCK_TOKEN)
    return core, clock, transport, latch


def _midpoint() -> float:
    """Returns the middle of the draw range, so a backoff window is halved in tests.

    Returns:
        0.5.
    """
    return 0.5
