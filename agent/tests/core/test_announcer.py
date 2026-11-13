"""The announcer: the order of the events of a transition, and the latch flag it keeps."""

from __future__ import annotations

import pytest

from fleet_agent.core.announcer import Announcer
from fleet_agent.core.corelog import CoreLog
from fleet_agent.core.effects import EffectOutcome
from fleet_agent.core.ids import uuid7
from fleet_agent.core.messages import MessageFactory
from fleet_agent.core.outbox import Outbox
from fleet_agent.core.scheduler import TelemetryScheduler
from fleet_agent.core.throttle import LogThrottle

from .fakes import ROBOT_ID, SITE_ID, FakeClock, FakeTransport, body_of, labels


def _announcer() -> tuple[Announcer, FakeTransport]:
    """Builds an announcer over a fake transport, with a fresh factory, scheduler and log.

    Returns:
        The announcer and the transport its events go through.
    """
    clock = FakeClock()
    transport = FakeTransport()
    boot_id = uuid7()
    factory = MessageFactory(
        robot_id=ROBOT_ID,
        site_id=SITE_ID,
        boot_id=boot_id,
        clock=clock,
        new_id=uuid7,
    )
    scheduler = TelemetryScheduler(simulated=False)
    log = CoreLog(robot_id=ROBOT_ID, site_id=SITE_ID, boot_id=boot_id, throttle=LogThrottle(clock))
    outbox = Outbox(
        transport=transport,
        factory=factory,
        scheduler=scheduler,
        log=log,
        clock=clock,
    )
    return Announcer(outbox=outbox, log=log, scheduler=scheduler), transport


def test_a_grant_without_its_holder_is_refused() -> None:
    """Given a grant with no holder, the announcer refuses it: the table never produces one."""
    announcer, _ = _announcer()

    with pytest.raises(TypeError, match="holder"):
        announcer.lock("ACQUIRED", None)


def test_a_refresh_by_the_holder_is_silent() -> None:
    """Given the holder renewing the lock, nothing is published."""
    announcer, transport = _announcer()

    announcer.lock("REFRESHED", None)

    assert transport.published == []


def test_a_release_publishes_a_free_lock_that_names_no_holder() -> None:
    """Given a release, the lock event says the lock is free and names nobody."""
    announcer, transport = _announcer()

    announcer.lock("RELEASED", None)

    assert labels(transport) == ["LOCK_CHANGED"]
    assert body_of(transport, 0)["held"] is False
    assert "holder" not in body_of(transport, 0)


def test_a_grant_publishes_the_holder() -> None:
    """Given a takeover, the lock event names the new holder."""
    announcer, transport = _announcer()

    announcer.lock("TAKEOVER", "operator-sub-2")

    assert body_of(transport, 0)["holder"] == "operator-sub-2"
    assert body_of(transport, 0)["cause"] == "TAKEOVER"


def test_a_transition_announces_its_state_then_its_lock_then_its_latch() -> None:
    """Given a transition that changes state and takes the lock, the events come in order."""
    announcer, transport = _announcer()

    announcer.transition(
        from_state="IDLE",
        to_state="TELEOP",
        changed=True,
        cause="TAKE_CONTROL",
        command_id=uuid7(),
        outcome=EffectOutcome(lock_change="ACQUIRED", latch="SET"),
        holder_sub="operator-sub-1",
    )

    assert labels(transport) == ["STATE_CHANGED", "LOCK_CHANGED"]
    assert body_of(transport, 0)["to"] == "TELEOP"


def test_faults_are_announced_raised_first_then_cleared() -> None:
    """Given a transition that raises one fault and clears another, the raise is announced first."""
    announcer, transport = _announcer()

    announcer.faults(EffectOutcome(fault_raised="OBSTACLE", fault_cleared="SENSOR_FAULT"))

    assert labels(transport) == ["FAULT_RAISED", "FAULT_CLEARED"]


def test_a_failed_latch_write_clears_the_flag_until_a_later_write_succeeds() -> None:
    """Given a latch write that failed, the flag stays false until a write or a clear succeeds."""
    announcer, _ = _announcer()
    assert announcer.latch_persisted is True

    announcer.latch("SET_FAILED", uuid7())
    assert announcer.latch_persisted is False

    announcer.latch("SET", uuid7())
    assert announcer.latch_persisted is True

    announcer.latch("SET_FAILED", uuid7())
    announcer.latch("CLEARED", None)
    assert announcer.latch_persisted is True


def test_an_untouched_latch_changes_nothing() -> None:
    """Given a transition that did not touch the latch, the flag is left as it was."""
    announcer, _ = _announcer()
    announcer.latch("SET_FAILED", uuid7())

    announcer.latch(None, None)

    assert announcer.latch_persisted is False
