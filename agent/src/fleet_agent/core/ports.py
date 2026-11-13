"""Ports: the interfaces through which the robot core reaches the world.

The core never imports a broker client, a file system call or a wall clock. It asks these
protocols for time, for MQTT traffic and for the e-stop latch, and the adapters in
`fleet_agent.adapters` implement them. Tests implement them with fakes, so the safety logic runs
without a network or a disk.

Threading contract: every `TransportListener` method and every `on_done` callback runs on the
event-loop thread. The core is single-threaded by construction, so it needs no lock.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    import asyncio

    from fleet_agent.config.kit_file import LoadedKit
    from fleet_agent.core.model import Destination, Point

QoS = Literal[0, 1]
"""MQTT quality of service the core asks for. QoS 2 is not used by the protocol."""

PublishStatus = Literal["OK", "NOT_AUTHORIZED", "REFUSED", "FAILED"]
"""Outcome of a publish: accepted, denied by broker policy, refused with another code, or failed."""

SubscribeStatus = Literal["GRANTED", "NOT_AUTHORIZED", "REFUSED", "FAILED"]
"""Outcome of a subscribe, mapped from the SUBACK reason code."""


@dataclass(frozen=True, slots=True)
class PublishOutcome:
    """Result of one publish, as the transport reports it.

    Attributes:
        status: The mapped outcome.
        reason_code: The MQTT reason code when the broker gave one, for logs.
        error_name: The exception class name when the publish failed locally, for logs.
    """

    status: PublishStatus
    reason_code: int | None = None
    error_name: str | None = None


@dataclass(frozen=True, slots=True)
class SubscribeOutcome:
    """Result of one subscribe, as the transport reports it.

    Attributes:
        status: The mapped outcome.
        reason_code: The MQTT reason code when the broker gave one, for logs.
        error_name: The exception class name when the subscribe failed locally, for logs.
    """

    status: SubscribeStatus
    reason_code: int | None = None
    error_name: str | None = None


@dataclass(frozen=True, slots=True)
class LatchRecord:
    """Content of the e-stop latch: which command set it, on which boot, and when.

    Attributes:
        command_id: The identifier of the ESTOP command.
        boot_id: The boot in which the latch was set.
        latched_at: The wall time of the latch, as ISO 8601 with milliseconds in UTC.
    """

    command_id: str
    boot_id: str
    latched_at: str


class Clock(Protocol):
    """Source of time. Monotonic time drives every timer; wall time serves ages and stamps only."""

    def monotonic_ms(self) -> int:
        """Returns the monotonic time in milliseconds. It never goes backwards.

        Returns:
            A non-negative integer, unaffected by wall-clock steps.
        """
        ...

    def wall_ms(self) -> int:
        """Returns the wall-clock time in milliseconds since the Unix epoch.

        Returns:
            A non-negative integer. It may jump when NTP steps the clock.
        """
        ...


class TransportListener(Protocol):
    """Receives the transport's events. Implemented by the agent core, called on the loop thread."""

    def on_connected(self) -> None:
        """Called once a connection is established."""
        ...

    def on_disconnected(self, error_name: str | None, reason_code: int | None) -> None:
        """Called when an established connection is lost.

        Args:
            error_name: The local error class name, when the loss had one.
            reason_code: The MQTT reason code, when the broker sent one.
        """
        ...

    def on_connect_failed(self, error_name: str | None, reason_code: int | None) -> None:
        """Called when an attempt to connect fails. The transport retries by itself.

        Args:
            error_name: The local error class name, when the attempt had one.
            reason_code: The CONNACK reason code, when the broker sent one.
        """
        ...

    def on_message(self, topic: str, payload: bytes) -> None:
        """Called for every message delivered on a subscription.

        Args:
            topic: The topic the message arrived on.
            payload: The raw payload, untrusted until the core has screened it.
        """
        ...


class Link(Protocol):
    """The part of the MQTT link the core drives: publishes, subscribes and suspends.

    The runner owns the rest of the transport, so the core is typed against this narrower port.
    """

    def publish(
        self,
        topic: str,
        payload: bytes,
        qos: QoS,
        on_done: Callable[[PublishOutcome], None] | None = None,
    ) -> None:
        """Publishes a message without waiting for it.

        Args:
            topic: The full topic. The transport does not rewrite it.
            payload: The serialised message.
            qos: The quality of service to request.
            on_done: Called with the outcome, when the transport knows it. QoS 0 gets an OK.
        """
        ...

    def subscribe(self, topic_filter: str, on_done: Callable[[SubscribeOutcome], None]) -> None:
        """Subscribes to a topic filter and reports the SUBACK outcome.

        Args:
            topic_filter: The filter to subscribe to.
            on_done: Called once with the outcome.
        """
        ...

    def suspend(self, duration_ms: int) -> None:
        """Drops the link on purpose for a while, as a DROP_LINK fault simulates.

        Args:
            duration_ms: How long the link stays down before the transport restarts.
        """
        ...


class Transport(Link, Protocol):
    """MQTT link to the cloud. The core drives it through `Link`; only the runner calls the rest."""

    def set_listener(self, listener: TransportListener) -> None:
        """Registers the object that receives the transport's events.

        Args:
            listener: The listener. It replaces any previous one.
        """
        ...

    def start(self) -> None:
        """Starts connecting. Reconnection afterwards is the transport's job."""
        ...

    async def stop(self, timeout_s: float) -> None:
        """Disconnects cleanly, waiting at most `timeout_s` for the broker to confirm.

        The runner calls it at shutdown. The core never does.

        Args:
            timeout_s: Upper bound of the wait, in seconds.
        """
        ...


TransportFactory = Callable[["LoadedKit", int, "asyncio.AbstractEventLoop"], Transport]
"""Builds the transport of one robot from its kit, the broker port and the loop. The kit type is
imported for the checker only, so the core carries no runtime dependency on the config package."""


class LatchStore(Protocol):
    """Durable storage of the e-stop latch. A latched robot boots stopped."""

    def is_set(self) -> bool:
        """Tells whether the latch is set.

        Returns:
            True when the robot must boot in ESTOP.

        Raises:
            LatchUnreadableError: If the store cannot be read. The caller must not guess.
        """
        ...

    def set(self, record: LatchRecord) -> None:
        """Durably sets the latch.

        Args:
            record: The content to store.

        Raises:
            LatchWriteError: If the latch cannot be written.
        """
        ...

    def clear(self) -> None:
        """Removes the latch.

        Raises:
            LatchWriteError: If the latch cannot be removed.
        """
        ...


class LatchUnreadableError(Exception):
    """The latch store cannot tell whether the latch is set. The boot is refused for safety."""


class LatchWriteError(Exception):
    """The latch store cannot be written or cleared."""


@dataclass(frozen=True, slots=True)
class Waypoint:
    """One point the robot drives to on its way to a destination.

    Attributes:
        point: The position to reach.
        final: Whether this is the destination itself. Only a final waypoint completes the move:
            an intermediate one is passed on without an arrival.
    """

    point: Point
    final: bool


class Navigator(Protocol):
    """Chooses the path of a robot in MOVING. The core asks it, the navigator never moves the robot.

    The default navigator drives in a straight line. A simulator plugs in a planner that routes
    around obstacles, through the same two calls, so the core keeps one motion path.
    """

    def next_waypoint(self, x: float, y: float, destination: Destination) -> Waypoint | None:
        """Returns the point to drive to next, from the robot's position.

        Args:
            x: The robot's position on the x axis, in metres.
            y: The robot's position on the y axis, in metres.
            destination: The destination the robot is heading to.

        Returns:
            The next waypoint, or None when no path is known yet: the robot then holds position.
        """
        ...

    def reached(self, waypoint: Waypoint) -> None:
        """Tells the navigator that the robot reached an intermediate waypoint.

        It is not called for a final waypoint, after which the robot arrives.

        Args:
            waypoint: The intermediate waypoint that was reached.
        """
        ...
