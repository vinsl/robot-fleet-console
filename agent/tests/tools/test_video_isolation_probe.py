"""Tests of the video isolation probe: the six checks against scripted service policies.

No test touches the network: the credentials provider and the HTTP sender are fakes. Signing is
the real awscrt signer, run offline with fake static credentials.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from datetime import UTC, datetime, timedelta
from http.client import HTTPMessage
from pathlib import Path

import pytest

from fleet_agent import cli
from fleet_agent.config.kit_file import LoadedKit, TlsMaterial
from fleet_agent.protocol.robots import RobotKitConfig
from fleet_agent.tools.isolation_probe import ProbeResult
from fleet_agent.tools.video_isolation_probe import (
    HttpReply,
    UrllibAwsHttpPost,
    _NoRedirectHandler,
    other_channel_arn_for,
    run_video_isolation_probe,
)
from fleet_agent.video.credentials import AwsCredentialsLike, AwsCredentialsProviderLike
from tests.kit_fixtures import ROBOT_ID, write_kit
from tests.protocol.conftest import FIXTURES_DIR, read_fixture

_VALID_KIT = FIXTURES_DIR / "register-robot-response" / "valid" / "01.json"
OTHER_ROBOT = "sim-99"
GET_ENDPOINT = "/getSignalingChannelEndpoint"
DESCRIBE = "/describeSignalingChannel"
DENIED_CHECKS = ("other-channel-master-endpoint", "other-channel-viewer-endpoint")
ALL_CHECKS = (
    "own-credentials",
    "own-channel-master-endpoint",
    "other-channel-master-endpoint",
    "other-channel-viewer-endpoint",
    "own-channel-describe",
    "other-thing-credentials",
)
ACCESS_DENIED_BODY = "AccessDeniedException:http://internal.example/unused"
Responder = Callable[[str, Mapping[str, object]], HttpReply]


def _kit() -> LoadedKit:
    """Builds the loaded kit of the fixture robot, with placeholder TLS material.

    Returns:
        The loaded kit. The probe's fakes never read the TLS material.
    """
    document = read_fixture(_VALID_KIT)
    assert isinstance(document, dict)
    config = RobotKitConfig.model_validate(document["kit"]["config"])
    tls = TlsMaterial(certificate_pem=b"certificate", private_key_pem=b"key", root_ca_pem=b"ca")
    return LoadedKit(config=config, tls=tls, kit_dir=Path("/unused"))


class _Credentials:
    """Fake credentials with the fields the agent reads."""

    access_key_id: str | None = "ASIA" + "A" * 16
    secret_access_key: str | None = "s" * 40
    session_token: str | None = "T" * 32

    def __init__(self) -> None:
        """Sets the expiration one hour ahead, well beyond the minimum validity."""
        self.expiration: datetime | None = datetime.now(UTC) + timedelta(hours=1)


class _Provider:
    """Fake credentials provider: returns credentials, or fails with the given error."""

    def __init__(self, *, error: Exception | None = None) -> None:
        """Creates the provider.

        Args:
            error: When given, every request fails with this error.
        """
        self._error = error

    def get_credentials(self) -> Future[AwsCredentialsLike]:
        """Returns a completed request, with credentials or with the configured error.

        Returns:
            The completed future.
        """
        future: Future[AwsCredentialsLike] = Future()
        if self._error is not None:
            future.set_exception(self._error)
        else:
            credentials: AwsCredentialsLike = _Credentials()
            future.set_result(credentials)
        return future


class _Scripted(_Provider):
    """Fake provider that answers from a script, one answer per call, and repeats the last one.

    An answer of None is working credentials; an exception is the error the request fails with.
    """

    def __init__(self, *script: Exception | None) -> None:
        """Creates the provider.

        Args:
            script: The answers, in call order.
        """
        super().__init__()
        self._script = list(script)
        self.calls = 0

    def get_credentials(self) -> Future[AwsCredentialsLike]:
        """Returns a completed request for the answer of this call.

        Returns:
            The completed future, with credentials or with the scripted error.
        """
        self.calls += 1
        answer = self._script[min(self.calls, len(self._script)) - 1]
        future: Future[AwsCredentialsLike] = Future()
        if answer is None:
            credentials: AwsCredentialsLike = _Credentials()
            future.set_result(credentials)
        else:
            future.set_exception(answer)
        return future


class _Http:
    """Fake HTTP sender: records every request and answers from a responder."""

    def __init__(self, respond: Responder) -> None:
        """Creates the sender.

        Args:
            respond: Answers a request from its path and its decoded JSON body.
        """
        self._respond = respond
        self.calls: list[tuple[str, Mapping[str, str], bytes]] = []

    def post(self, url: str, headers: Mapping[str, str], body: bytes) -> HttpReply:
        """Records the request and answers it.

        Args:
            url: The request URL.
            headers: The signed headers.
            body: The JSON body.

        Returns:
            The scripted reply.
        """
        self.calls.append((url, headers, body))
        path = "/" + url.split(".amazonaws.com/", 1)[1]
        decoded = json.loads(body)
        assert isinstance(decoded, dict)
        return self._respond(path, decoded)

    @property
    def paths(self) -> set[str]:
        """Returns the operations called, as paths.

        Returns:
            The set of called paths.
        """
        return {"/" + url.split(".amazonaws.com/", 1)[1] for url, _, _ in self.calls}


def _correct_policy(own_arn: str) -> Responder:
    """Answers as the correct policy does: the own channel is readable, nothing else is.

    Args:
        own_arn: The robot's own channel ARN.

    Returns:
        The responder.
    """

    def respond(path: str, body: Mapping[str, object]) -> HttpReply:
        """Answers one request.

        Args:
            path: The operation's path.
            body: The decoded body.

        Returns:
            The reply.
        """
        if path == GET_ENDPOINT and body.get("ChannelARN") == own_arn:
            return HttpReply(status=200, error_type=None)
        return HttpReply(status=403, error_type=ACCESS_DENIED_BODY)

    return respond


def _providers(
    *,
    own: _Provider | None = None,
    other: _Provider | None = None,
) -> Callable[[LoadedKit], AwsCredentialsProviderLike]:
    """Builds the provider factory: the own identity and the other thing name get their own fake.

    Args:
        own: The provider for the robot's own thing name. Defaults to working credentials.
        other: The provider for the other thing name. Defaults to a refusal.

    Returns:
        A factory in the shape the probe expects.
    """
    own_provider = own if own is not None else _Provider()
    other_provider = other if other is not None else _Provider(error=RuntimeError("refused"))
    own_thing = _kit().config.thing_name

    def factory(kit: LoadedKit) -> AwsCredentialsProviderLike:
        """Returns the fake provider of the thing name the kit presents.

        Args:
            kit: The kit the probe builds a source for.

        Returns:
            The fake provider.
        """
        return own_provider if kit.config.thing_name == own_thing else other_provider

    return factory


def _probe(
    http: _Http,
    *,
    own: _Provider | None = None,
    other: _Provider | None = None,
    other_channel_arn: str | None = None,
) -> list[ProbeResult]:
    """Runs the probe synchronously with the given fakes.

    Args:
        http: The HTTP fake.
        own: The own-identity provider fake.
        other: The other-thing provider fake.
        other_channel_arn: The optional real ARN of the other channel.

    Returns:
        The results of the six checks.
    """
    return asyncio.run(
        run_video_isolation_probe(
            _kit(),
            other_robot_id=OTHER_ROBOT,
            other_channel_arn=other_channel_arn,
            provider_factory=_providers(own=own, other=other),
            http=http,
        )
    )


def _by_name(results: list[ProbeResult]) -> dict[str, ProbeResult]:
    """Indexes the results by check name.

    Args:
        results: The results.

    Returns:
        The results keyed by check.
    """
    return {result.check: result for result in results}


def _own_arn() -> str:
    """Returns the robot's own channel ARN from the fixture kit.

    Returns:
        The ARN.
    """
    return _kit().config.kvs_channel_arn


def test_a_correct_policy_passes_the_six_checks_and_exits_zero() -> None:
    """A policy that grants only the own channel passes all six checks, with fixed labels."""
    http = _Http(_correct_policy(_own_arn()))

    results = _probe(http)

    assert [result.check for result in results] == list(ALL_CHECKS)
    assert [result.observed for result in results] == [
        "CREDENTIALS_OK",
        "HTTP_200",
        "ACCESS_DENIED",
        "ACCESS_DENIED",
        "ACCESS_DENIED",
        "PROVIDER_REFUSED",
    ]


def test_a_channel_the_policy_grants_fails_the_check() -> None:
    """Granting the other robot's channel is a failure: the policy is too wide."""

    def too_wide(path: str, body: Mapping[str, object]) -> HttpReply:
        """Grants every endpoint request, and refuses the describe.

        Args:
            path: The operation's path.
            body: The decoded body.

        Returns:
            The reply.
        """
        if path == GET_ENDPOINT:
            return HttpReply(status=200, error_type=None)
        return HttpReply(status=403, error_type=ACCESS_DENIED_BODY)

    results = _by_name(_probe(_Http(too_wide)))

    assert results["other-channel-master-endpoint"].observed == "HTTP_200"
    assert results["other-channel-master-endpoint"].passed is False
    assert results["other-channel-viewer-endpoint"].passed is False


def test_a_not_found_on_the_other_channel_is_inconclusive_and_fails() -> None:
    """A 404 proves nothing about the policy: the channel check fails as INCONCLUSIVE."""
    own_arn = _own_arn()

    def not_found(path: str, body: Mapping[str, object]) -> HttpReply:
        """Answers the own channel with 200 and every other ARN with a 404.

        Args:
            path: The operation's path.
            body: The decoded body.

        Returns:
            The reply.
        """
        if path == GET_ENDPOINT and body.get("ChannelARN") == own_arn:
            return HttpReply(status=200, error_type=None)
        if path == GET_ENDPOINT:
            return HttpReply(status=404, error_type="ResourceNotFoundException:x")
        return HttpReply(status=403, error_type=ACCESS_DENIED_BODY)

    results = _by_name(_probe(_Http(not_found)))

    assert results["other-channel-master-endpoint"].observed == "INCONCLUSIVE"
    assert results["other-channel-master-endpoint"].passed is False
    assert results["other-channel-viewer-endpoint"].observed == "INCONCLUSIVE"


def test_a_refused_own_channel_fails_the_control_and_the_channel_checks() -> None:
    """Without the positive control, a refusal of another channel proves nothing: all fail."""
    http = _Http(lambda path, body: HttpReply(status=403, error_type=ACCESS_DENIED_BODY))

    results = _by_name(_probe(http))

    assert results["own-channel-master-endpoint"].observed == "ACCESS_DENIED"
    assert results["own-channel-master-endpoint"].passed is False
    for name in (*DENIED_CHECKS, "own-channel-describe"):
        assert results[name].observed == "CONTROL_FAILED"
        assert results[name].passed is False
    assert results["other-thing-credentials"].passed is True
    assert http.paths == {GET_ENDPOINT}


def test_no_own_credentials_fails_every_check_without_a_request() -> None:
    """Without the robot's own credentials nothing is sent, and every check is NOT_AUTHENTICATED."""
    http = _Http(_correct_policy(_own_arn()))

    results = _probe(http, own=_Provider(error=RuntimeError("denied")))

    assert [result.observed for result in results] == ["NOT_AUTHENTICATED"] * 6
    assert all(result.passed is False for result in results)
    assert http.calls == []


def test_a_provider_refusal_is_inconclusive_and_fails_when_the_own_refetch_fails() -> None:
    """A refusal proves the policy only when the network was up. If the robot's own credentials
    cannot be fetched right after it, the check is inconclusive and fails.
    """
    http = _Http(_correct_policy(_own_arn()))
    own = _Scripted(None, RuntimeError("network down"))

    results = _by_name(_probe(http, own=own))

    other = results["other-thing-credentials"]
    assert other.observed == "INCONCLUSIVE"
    assert other.passed is False
    assert own.calls == 2


def test_a_provider_refusal_passes_only_after_the_own_refetch_succeeds() -> None:
    """The own credentials are fetched a second time right after the refusal, and that proves it."""
    http = _Http(_correct_policy(_own_arn()))
    own = _Scripted(None, None)

    results = _by_name(_probe(http, own=own))

    other = results["other-thing-credentials"]
    assert other.observed == "PROVIDER_REFUSED"
    assert other.passed is True
    assert own.calls == 2


def test_the_probe_logs_nothing_and_writes_only_fixed_labels(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No request body, header or credential reaches a log, and every label is a fixed one."""
    caplog.set_level(logging.DEBUG)
    http = _Http(_correct_policy(_own_arn()))

    results = _probe(http)

    assert [record for record in caplog.records if record.name.startswith("fleet_agent")] == []
    allowed = {
        "CREDENTIALS_OK",
        "HTTP_200",
        "ACCESS_DENIED",
        "PROVIDER_REFUSED",
        "INCONCLUSIVE",
        "NOT_AUTHENTICATED",
        "CONTROL_FAILED",
        "NETWORK_ERROR",
        "SIGNING_FAILED",
        "UNEXPECTED",
    }
    assert {result.observed for result in results} <= allowed


def test_only_the_two_read_only_operations_are_called() -> None:
    """The probe sends only GetSignalingChannelEndpoint and DescribeSignalingChannel."""
    http = _Http(_correct_policy(_own_arn()))

    _probe(http)

    assert http.paths == {GET_ENDPOINT, DESCRIBE}
    assert len(http.calls) == 4


def test_requests_are_signed_by_awscrt_and_carry_the_session_token() -> None:
    """Every request carries a SigV4 header set made by awscrt, with the session token."""
    http = _Http(_correct_policy(_own_arn()))

    _probe(http)

    assert http.calls
    for url, headers, _ in http.calls:
        assert url.startswith("https://kinesisvideo.")
        lowered = {name.lower(): value for name, value in headers.items()}
        assert lowered["authorization"].startswith("AWS4-HMAC-SHA256 Credential=ASIA")
        assert lowered["x-amz-security-token"] == "T" * 32
        assert "x-amz-date" in lowered


def test_an_explicit_other_channel_arn_is_the_one_sent() -> None:
    """The operator's real ARN replaces the synthetic one in the master and viewer checks."""
    real = f"arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-{OTHER_ROBOT}/42"
    seen: list[object] = []

    def record(path: str, body: Mapping[str, object]) -> HttpReply:
        """Records the channel ARN of each endpoint request and answers as the policy.

        Args:
            path: The operation's path.
            body: The decoded body.

        Returns:
            The reply.
        """
        if path == GET_ENDPOINT:
            seen.append(body.get("ChannelARN"))
        if path == GET_ENDPOINT and body.get("ChannelARN") == _own_arn():
            return HttpReply(status=200, error_type=None)
        return HttpReply(status=403, error_type=ACCESS_DENIED_BODY)

    results = _probe(_Http(record), other_channel_arn=real)

    assert seen[1:3] == [real, real]
    assert all(result.passed for result in results)


def test_the_synthetic_other_channel_arn_names_the_other_robot_in_the_own_account() -> None:
    """Without an operator ARN, the probe builds one in the own account, for the other channel."""
    own_arn = _own_arn()
    seen: list[object] = []
    policy = _correct_policy(own_arn)

    def record(path: str, body: Mapping[str, object]) -> HttpReply:
        """Records the channel ARN of each endpoint request, and answers as the policy.

        Args:
            path: The operation's path.
            body: The decoded body.

        Returns:
            The reply.
        """
        if path == GET_ENDPOINT:
            seen.append(body.get("ChannelARN"))
        return policy(path, body)

    _probe(_Http(record))

    account = own_arn.split(":")[4]
    expected = (
        f"arn:aws:kinesisvideo:eu-west-3:{account}:channel/mfc-demo-{OTHER_ROBOT}/1700000000000"
    )
    assert seen[1:3] == [expected, expected]


def test_other_channel_arn_must_name_the_other_robots_channel() -> None:
    """An ARN is accepted only when it matches the pattern and names the other robot's channel."""
    good = f"arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-{OTHER_ROBOT}/42"

    assert other_channel_arn_for(good, OTHER_ROBOT) == good
    with pytest.raises(ValueError, match="not a channel ARN"):
        other_channel_arn_for("arn:aws:s3:::bucket", OTHER_ROBOT)
    with pytest.raises(ValueError, match="other robot's channel"):
        other_channel_arn_for(good, "sim-98")


def test_the_urllib_sender_refuses_a_plain_http_url() -> None:
    """The production sender never opens a URL that is not HTTPS."""
    sender = UrllibAwsHttpPost()

    with pytest.raises(ValueError, match="HTTPS"):
        sender.post("http://kinesisvideo.eu-west-3.amazonaws.com/x", {}, b"{}")


def test_the_redirect_handler_declines_every_redirect() -> None:
    """A redirect is never followed, so a signed request cannot be sent to another location."""
    request = urllib.request.Request("https://kinesisvideo.eu-west-3.amazonaws.com/x")

    declined = _NoRedirectHandler().redirect_request(
        request,
        io.BytesIO(),
        302,
        "Found",
        HTTPMessage(),
        "https://elsewhere.example/",
    )

    assert declined is None


def test_a_probe_against_the_robot_itself_is_a_usage_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The video probe refuses B == A with exit 64, before anything is sent."""
    write_kit(tmp_path)

    code = cli.main(
        [
            "probe-video-isolation",
            "--robot-id",
            ROBOT_ID,
            "--other-robot-id",
            ROBOT_ID,
            "--kit-root",
            str(tmp_path),
        ]
    )

    captured = capsys.readouterr()
    assert code == cli.EXIT_USAGE
    assert captured.out == ""
    assert "must not be the robot itself" in captured.err
