"""Tests of the isolation probe: the nine checks against scripted broker policies."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from fleet_agent.config.kit_file import KitError, LoadedKit, TlsMaterial
from fleet_agent.core.ports import TransportFactory
from fleet_agent.protocol.robots import RobotKitConfig
from fleet_agent.protocol.topics import ack_topic, command_topic, events_topic
from fleet_agent.tools.isolation_probe import ProbeResult, run_isolation_probe
from tests.protocol.conftest import FIXTURES_DIR, read_fixture
from tests.tools.policy_broker import (
    Deny,
    PolicyTransport,
    own_publish_topics,
    own_subscribe_filters,
)

_VALID_KIT = FIXTURES_DIR / "register-robot-response" / "valid" / "01.json"
OTHER_SITE = "sim-site-01"
OTHER_ROBOT = "sim-99"
PORT = 8883
WILDCARD = "fleet/+/+/cmd"

ALLOWED_CHECKS = ("own-events-publish", "own-cmd-subscribe", "own-ack-publish")
DENIED_CHECKS = (
    "other-events-publish",
    "other-ack-publish",
    "other-cmd-subscribe",
    "own-cmd-publish",
    "wildcard-cmd-subscribe",
    "other-client-connect",
)
ACTION_DENIED_CHECKS = tuple(name for name in DENIED_CHECKS if name != "other-client-connect")


def _kit() -> LoadedKit:
    """Builds the loaded kit of the fixture robot, with placeholder TLS material.

    The probe never reaches the TLS material: the policy transport stands in for the SDK. The
    config is the real one from the fixture, so the topics are the real ones.

    Returns:
        The loaded kit.
    """
    document = read_fixture(_VALID_KIT)
    assert isinstance(document, dict)
    config = RobotKitConfig.model_validate(document["kit"]["config"])
    tls = TlsMaterial(
        certificate_pem=b"certificate",
        private_key_pem=b"key",
        root_ca_pem=b"ca",
    )
    return LoadedKit(config=config, tls=tls, kit_dir=Path("/unused"))


def _policy_factory(
    *,
    allowed: frozenset[str] | None = None,
    allowed_filters: frozenset[str] | None = None,
    deny: Deny = "NOT_AUTHORIZED",
    refuse_connect: bool = False,
    silent_connect: bool = False,
    accept_other_client_ids: bool = False,
    drop_on_connect: bool = False,
    created: list[PolicyTransport] | None = None,
    kits: list[LoadedKit] | None = None,
) -> TransportFactory:
    """Builds a transport factory whose every transport follows the same policy.

    A connection under another client identifier is refused, as the correct policy does, unless
    the test says the broker accepts it.

    Args:
        allowed: The publish topics granted. Defaults to the robot's own, the correct policy.
        allowed_filters: The subscribe filters granted. Defaults to the robot's own command topic.
        deny: How every other topic is refused.
        refuse_connect: Whether every connection attempt fails.
        silent_connect: Whether every connection attempt never completes.
        accept_other_client_ids: Whether a connection under another client identifier is allowed.
        drop_on_connect: Whether an accepted connection is dropped at once with reason 135.
        created: When given, every transport built is appended to it.
        kits: When given, the kit of every transport built is appended to it.

    Returns:
        A factory with the transport factory signature.
    """
    own_name = _kit().config.thing_name
    own = _kit().config

    def factory(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> PolicyTransport:
        """Builds one policy transport for a check.

        Args:
            kit: The loaded kit the probe passed, whose thing name is the client identifier.
            port: The broker port, which the probe passed.
            loop: The loop, which the probe passed.

        Returns:
            A new transport following the policy.
        """
        del loop
        assert port == PORT
        other_client = kit.config.thing_name != own_name
        refused = refuse_connect or (other_client and not accept_other_client_ids)
        transport = PolicyTransport(
            allowed_topics=(
                allowed if allowed is not None else own_publish_topics(own.site_id, own.robot_id)
            ),
            allowed_filters=(
                allowed_filters
                if allowed_filters is not None
                else own_subscribe_filters(own.site_id, own.robot_id)
            ),
            deny=deny,
            refuse_connect=refused,
            silent_connect=silent_connect,
            drop_on_connect=drop_on_connect,
        )
        if created is not None:
            created.append(transport)
        if kits is not None:
            kits.append(kit)
        return transport

    return factory


def _run(kit: LoadedKit, factory: TransportFactory, timeout_s: float = 1.0) -> list[ProbeResult]:
    """Runs the probe against the other robot, under the given factory.

    Args:
        kit: The loaded kit.
        factory: The transport factory.
        timeout_s: The probe's timeout for each wait.

    Returns:
        The probe's results.
    """
    return asyncio.run(
        run_isolation_probe(
            kit,
            other_site_id=OTHER_SITE,
            other_robot_id=OTHER_ROBOT,
            port=PORT,
            transport_factory=factory,
            timeout_s=timeout_s,
            spacing_s=0,
        )
    )


def _by_name(results: list[ProbeResult]) -> dict[str, ProbeResult]:
    """Indexes the results by check name.

    Args:
        results: The probe's results.

    Returns:
        The results keyed by check name.
    """
    return {result.check: result for result in results}


def _own_events_only(kit: LoadedKit) -> frozenset[str]:
    """Lists the one publish topic a robot may use: its own events.

    Args:
        kit: The loaded kit.

    Returns:
        The publish topics of a policy without the own acknowledgement topic.
    """
    return frozenset({events_topic(kit.config.site_id, kit.config.robot_id)})


def test_a_correct_policy_passes_every_check() -> None:
    """The robot may use its three own actions and is refused the six others: all nine pass."""
    results = _run(_kit(), _policy_factory())

    assert [result.check for result in results] == [
        "own-events-publish",
        "own-cmd-subscribe",
        "own-ack-publish",
        "other-events-publish",
        "other-ack-publish",
        "other-cmd-subscribe",
        "own-cmd-publish",
        "wildcard-cmd-subscribe",
        "other-client-connect",
    ]
    assert all(result.passed for result in results)
    assert [result.observed for result in results] == [
        "OK",
        "GRANTED",
        "OK",
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED",
        "NOT_AUTHORIZED",
    ]


def test_each_check_uses_a_fresh_connection_that_is_stopped() -> None:
    """Every check connects with its own transport and stops it, so no connection is shared."""
    created: list[PolicyTransport] = []

    _run(_kit(), _policy_factory(created=created))

    assert len(created) == 9
    assert all(transport.started == 1 and transport.stops == 1 for transport in created)


def test_the_connection_check_uses_the_same_key_under_another_client_identifier() -> None:
    """The other-client check connects with the same TLS material, under another thing name."""
    kit = _kit()
    kits: list[LoadedKit] = []

    _run(kit, _policy_factory(kits=kits))

    other = kits[-1]
    assert other.config.thing_name == f"{kit.config.thing_name}-probe"
    assert other.tls is kit.tls
    assert kit.config.thing_name == "mfc-demo-kali-01"


def test_a_publish_granted_on_the_other_robot_fails_the_check() -> None:
    """A policy that lets the robot publish on another robot's events topic fails that check."""
    kit = _kit()
    allowed = own_publish_topics(kit.config.site_id, kit.config.robot_id) | {
        events_topic(OTHER_SITE, OTHER_ROBOT)
    }

    results = _by_name(_run(kit, _policy_factory(allowed=allowed)))

    assert results["other-events-publish"].observed == "OK"
    assert results["other-events-publish"].passed is False
    assert results["other-ack-publish"].passed is True


def test_an_ack_granted_on_the_other_robot_fails_the_check() -> None:
    """A policy that lets the robot publish acknowledgements for another robot fails that check."""
    kit = _kit()
    allowed = own_publish_topics(kit.config.site_id, kit.config.robot_id) | {
        ack_topic(OTHER_SITE, OTHER_ROBOT)
    }

    results = _by_name(_run(kit, _policy_factory(allowed=allowed)))

    assert results["other-ack-publish"].observed == "OK"
    assert results["other-ack-publish"].passed is False


def test_a_subscribe_granted_on_the_other_command_topic_fails_the_check() -> None:
    """A policy that lets the robot subscribe to another robot's commands fails that check."""
    kit = _kit()
    allowed = own_subscribe_filters(kit.config.site_id, kit.config.robot_id) | {
        command_topic(OTHER_SITE, OTHER_ROBOT)
    }

    results = _by_name(_run(kit, _policy_factory(allowed_filters=allowed)))

    assert results["other-cmd-subscribe"].observed == "GRANTED"
    assert results["other-cmd-subscribe"].passed is False


def test_the_robot_own_command_subscribe_must_be_granted() -> None:
    """A policy that refuses the robot's own command topic fails the own subscribe check."""
    results = _by_name(_run(_kit(), _policy_factory(allowed_filters=frozenset())))

    assert results["own-cmd-subscribe"].observed == "NOT_AUTHORIZED"
    assert results["own-cmd-subscribe"].passed is False


def test_the_robot_own_ack_publish_must_be_granted() -> None:
    """A policy that refuses the robot's own acknowledgements fails the own ack check."""
    kit = _kit()

    results = _by_name(_run(kit, _policy_factory(allowed=_own_events_only(kit))))

    assert results["own-ack-publish"].observed == "NOT_AUTHORIZED"
    assert results["own-ack-publish"].passed is False


def test_a_publish_granted_on_the_own_command_topic_fails_the_check() -> None:
    """A robot that may publish on its own command topic could forge commands: the check fails."""
    kit = _kit()
    allowed = own_publish_topics(kit.config.site_id, kit.config.robot_id) | {
        command_topic(kit.config.site_id, kit.config.robot_id)
    }

    results = _by_name(_run(kit, _policy_factory(allowed=allowed)))

    assert results["own-cmd-publish"].observed == "OK"
    assert results["own-cmd-publish"].passed is False


def test_a_wildcard_subscribe_granted_fails_the_check() -> None:
    """A policy that grants the wildcard over every robot's commands fails the wildcard check."""
    kit = _kit()
    allowed_filters = own_subscribe_filters(kit.config.site_id, kit.config.robot_id) | {WILDCARD}

    results = _by_name(_run(kit, _policy_factory(allowed_filters=allowed_filters)))

    assert results["wildcard-cmd-subscribe"].observed == "GRANTED"
    assert results["wildcard-cmd-subscribe"].passed is False


def test_a_second_client_identifier_accepted_with_the_same_key_fails_the_check() -> None:
    """A broker that accepts a connection under another client identifier fails the check."""
    results = _by_name(_run(_kit(), _policy_factory(accept_other_client_ids=True)))

    assert results["other-client-connect"].observed == "CONNECTED"
    assert results["other-client-connect"].passed is False


def test_a_disconnection_with_reason_135_counts_as_a_refusal() -> None:
    """The broker may drop an action with 135 instead of refusing it: that is a denial."""
    results = _by_name(_run(_kit(), _policy_factory(deny="DISCONNECT_135")))

    assert [results[name].observed for name in ACTION_DENIED_CHECKS] == ["DISCONNECT_135"] * 5
    assert all(results[name].passed for name in ACTION_DENIED_CHECKS)
    assert results["other-client-connect"].observed == "NOT_AUTHORIZED"


def test_a_disconnection_before_the_action_is_not_a_refusal() -> None:
    """A link dropped with 135 right after connecting, before any action, is not a pass.

    The action was never sent, so the broker never judged it. Every action check reads as a plain
    loss, and none of them passes.
    """
    results = _by_name(_run(_kit(), _policy_factory(drop_on_connect=True)))

    assert [results[name].observed for name in ALLOWED_CHECKS + ACTION_DENIED_CHECKS] == [
        "DISCONNECTED"
    ] * 8
    assert not any(results[name].passed for name in ACTION_DENIED_CHECKS)


def test_a_refusal_with_another_code_fails_the_check() -> None:
    """A refusal that is not NOT_AUTHORIZED is not the denial the probe looks for."""
    results = _by_name(_run(_kit(), _policy_factory(deny="REFUSED")))

    assert [results[name].observed for name in ACTION_DENIED_CHECKS] == ["REFUSED"] * 5
    assert not any(results[name].passed for name in ACTION_DENIED_CHECKS)


def test_a_check_with_no_answer_times_out_and_fails() -> None:
    """A broker that never answers an action fails the check rather than hanging the probe."""
    results = _by_name(_run(_kit(), _policy_factory(deny="SILENT"), timeout_s=0.05))

    assert [results[name].observed for name in ACTION_DENIED_CHECKS] == ["TIMEOUT"] * 5
    assert not any(results[name].passed for name in ACTION_DENIED_CHECKS)


def test_a_refused_connection_fails_the_robot_checks() -> None:
    """When the broker refuses the robot's connection, none of its own checks can pass."""
    results = _by_name(_run(_kit(), _policy_factory(refuse_connect=True), timeout_s=0.05))

    assert [results[name].observed for name in ALLOWED_CHECKS] == ["NOT_CONNECTED"] * 3
    assert not any(results[name].passed for name in ALLOWED_CHECKS)


def test_a_connection_that_never_completes_is_not_connected() -> None:
    """A connection that never completes ends each check as not connected, not as a hang."""
    results = _run(_kit(), _policy_factory(silent_connect=True), timeout_s=0.05)

    assert [result.observed for result in results] == ["NOT_CONNECTED"] * 9


def test_a_kit_the_transport_refuses_propagates_as_a_kit_error() -> None:
    """A transport that refuses the kit's key stops the probe with that error, not a result."""

    def refusing(kit: LoadedKit, port: int, loop: asyncio.AbstractEventLoop) -> PolicyTransport:
        """Refuses the kit, as a TLS context refusing the key does.

        Args:
            kit: The loaded kit.
            port: The broker port.
            loop: The loop.

        Raises:
            KitError: Always.
        """
        raise KitError("KIT_KEY_INVALID")

    with pytest.raises(KitError):
        _run(_kit(), refusing)


def test_the_probe_pauses_between_two_connections(monkeypatch: pytest.MonkeyPatch) -> None:
    """Given the default spacing, the probe waits before every connection except the first.

    The broker throttles a client identifier that reconnects within a second, which turned one
    check into a false NOT_CONNECTED on the first live run.
    """
    pauses: list[float] = []

    async def record(delay: float) -> None:
        pauses.append(delay)

    monkeypatch.setattr(asyncio, "sleep", record)
    kit = _kit()

    asyncio.run(
        run_isolation_probe(
            kit,
            other_site_id=OTHER_SITE,
            other_robot_id=OTHER_ROBOT,
            port=PORT,
            transport_factory=_policy_factory(),
        )
    )

    assert len(pauses) == 8
    assert all(pause >= 1.0 for pause in pauses)
