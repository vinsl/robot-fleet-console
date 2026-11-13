"""Video isolation probe: checks that the robot's video identity reaches only its own channel.

This is the video half of the M4 gate. The probe runs with robot A's kit and makes a fixed set of
read-only requests to Kinesis Video Streams: one positive control on A's own channel, then the
attempts that the policy must refuse (another robot's channel as master and as viewer, the
describe action, and the credentials of another thing name). It needs no MQTT connection, so it
can run while the agent runs.

Every signed request is produced by `awscrt.auth.aws_sign_request`; the probe never computes a
signature itself. The HTTP call is injected through `AwsHttpPost`, so the tests need no network,
and the production implementation refuses redirects and every scheme but HTTPS.

Only two operations are called, `GetSignalingChannelEndpoint` and `DescribeSignalingChannel`, and
neither mutates anything. A response body is never read beyond its status and error type, and no
request body, header or credential is ever logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from http.client import HTTPMessage
from typing import IO, Final, Literal, Protocol

from awscrt.auth import (
    AwsCredentialsProvider,
    AwsSignatureType,
    AwsSigningAlgorithm,
    AwsSigningConfig,
    aws_sign_request,
)
from awscrt.exceptions import AwsCrtError
from awscrt.http import HttpHeaders, HttpRequest

from fleet_agent.config.kit_file import KitError, LoadedKit
from fleet_agent.protocol.constants import THING_NAME_PREFIX
from fleet_agent.protocol.robot_video import VideoCredentials
from fleet_agent.protocol.robots import KVS_CHANNEL_ARN_PATTERN, channel_name_of_arn
from fleet_agent.tools.isolation_probe import Expected, ProbeResult
from fleet_agent.video.credentials import (
    CredentialsError,
    ProviderFactory,
    X509CredentialsSource,
    build_x509_provider,
)

_SERVICE: Final = "kinesisvideo"
_GET_ENDPOINT_PATH: Final = "/getSignalingChannelEndpoint"
_DESCRIBE_PATH: Final = "/describeSignalingChannel"
_REQUEST_TIMEOUT_S: Final = 10.0
_SIGNATURE_TIMEOUT_S: Final = 10.0
_ERROR_TYPE_HEADER: Final = "x-amzn-ErrorType"
_ACCESS_DENIED: Final = "AccessDeniedException"
_RESOURCE_NOT_FOUND: Final = "ResourceNotFoundException"
_OTHER_CHANNEL_TIMESTAMP_MS: Final = "1700000000000"
"""A synthetic channel suffix. IAM evaluates the resource ARN before the channel lookup, so any
ARN outside the robot's own channel must be refused, whether the channel exists or not."""
_MASTER: Final = "MASTER"
_VIEWER: Final = "VIEWER"

_CREDENTIALS_OK: Final = "CREDENTIALS_OK"
_HTTP_200: Final = "HTTP_200"
_ACCESS_DENIED_LABEL: Final = "ACCESS_DENIED"
_PROVIDER_REFUSED: Final = "PROVIDER_REFUSED"
_INCONCLUSIVE: Final = "INCONCLUSIVE"
_NOT_AUTHENTICATED: Final = "NOT_AUTHENTICATED"
_CONTROL_FAILED: Final = "CONTROL_FAILED"
_NETWORK_ERROR: Final = "NETWORK_ERROR"
_SIGNING_FAILED: Final = "SIGNING_FAILED"
_UNEXPECTED: Final = "UNEXPECTED"

_ALLOWED_LABELS: Final = frozenset({_CREDENTIALS_OK, _HTTP_200})
"""What an allowed check observes when the policy lets the action through."""
_DENIED_LABELS: Final = frozenset({_ACCESS_DENIED_LABEL, _PROVIDER_REFUSED})
"""What a denied check observes when the policy refuses the action."""

_CHECK_ORDER: Final[tuple[tuple[str, Expected], ...]] = (
    ("own-credentials", "ALLOWED"),
    ("own-channel-master-endpoint", "ALLOWED"),
    ("other-channel-master-endpoint", "DENIED"),
    ("other-channel-viewer-endpoint", "DENIED"),
    ("own-channel-describe", "DENIED"),
    ("other-thing-credentials", "DENIED"),
)
"""The six checks, in the order they run, with what the policy must do for each."""

_KVS_ARN_ACCOUNT_INDEX: Final = 4
"""The account field of a channel ARN, counted from the `arn` prefix."""


@dataclass(frozen=True, slots=True)
class HttpReply:
    """The part of an HTTP response the probe reads.

    Attributes:
        status: The HTTP status code.
        error_type: The value of the `x-amzn-ErrorType` header, when the service sent one.
    """

    status: int
    error_type: str | None


class AwsHttpPost(Protocol):
    """Sends one signed POST and returns the status. Injected so that tests need no network."""

    def post(self, url: str, headers: Mapping[str, str], body: bytes) -> HttpReply:
        """Sends the request and returns its status and error type.

        Args:
            url: The HTTPS URL of the operation.
            headers: The signed headers of the request.
            body: The JSON body the signature covers.

        Returns:
            The status and the error type of the response.

        Raises:
            OSError: When the request cannot be completed, including a timeout.
        """
        ...


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect, so a signed request is never sent to a location it did not name.

    A redirect answer is then returned as an error with its status, which the probe reports as
    an unexpected result.
    """

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> None:
        """Declines to follow the redirect.

        Args:
            req: The request that was redirected.
            fp: The response stream, unused.
            code: The redirect status, unused.
            msg: The reason phrase, unused.
            headers: The response headers, unused.
            newurl: The location, unused: it is never followed.
        """
        del req, fp, code, msg, headers, newurl
        return None


class UrllibAwsHttpPost:
    """Sends the signed POST with the standard library, over HTTPS with the system trust store.

    Redirects are refused and every other scheme is refused before the request is made.
    """

    def __init__(self, timeout_s: float = _REQUEST_TIMEOUT_S) -> None:
        """Creates the sender.

        Args:
            timeout_s: The deadline of one request, in seconds.
        """
        self._opener = urllib.request.build_opener(_NoRedirectHandler())
        self._timeout_s = timeout_s

    def post(self, url: str, headers: Mapping[str, str], body: bytes) -> HttpReply:
        """Sends the request and returns its status and error type. The body is discarded.

        Args:
            url: The HTTPS URL of the operation.
            headers: The signed headers of the request.
            body: The JSON body.

        Returns:
            The status and the error type of the response.

        Raises:
            ValueError: If the URL is not HTTPS. The probe builds only HTTPS URLs.
            OSError: When the request cannot be completed, including a timeout.
        """
        if not url.startswith("https://"):
            raise ValueError("probe requests must use HTTPS")
        # The scheme is checked above, so the opener can only ever open an HTTPS URL.
        request = urllib.request.Request(  # noqa: S310
            url, data=body, headers=dict(headers), method="POST"
        )
        try:
            with self._opener.open(request, timeout=self._timeout_s) as response:
                return HttpReply(status=response.status, error_type=None)
        except urllib.error.HTTPError as err:
            try:
                return HttpReply(status=err.code, error_type=err.headers.get(_ERROR_TYPE_HEADER))
            finally:
                err.close()


def other_channel_arn_for(arn: str, other_robot_id: str) -> str:
    """Validates an operator-supplied ARN of the other robot's channel.

    The ARN must match the channel pattern, and its channel must be the other robot's
    `mfc-demo-<id>` channel, so that the probe cannot be pointed at an unrelated resource.

    Args:
        arn: The ARN given on the command line.
        other_robot_id: The other robot's identifier.

    Returns:
        The ARN, unchanged.

    Raises:
        ValueError: If the ARN does not match the pattern or names another channel. The message
            names the rule, never the value.
    """
    if re.fullmatch(KVS_CHANNEL_ARN_PATTERN, arn) is None:
        raise ValueError("not a channel ARN")
    if channel_name_of_arn(arn) != f"{THING_NAME_PREFIX}{other_robot_id}":
        raise ValueError("the ARN must name the other robot's channel")
    return arn


async def run_video_isolation_probe(
    kit: LoadedKit,
    *,
    other_robot_id: str,
    other_channel_arn: str | None = None,
    provider_factory: ProviderFactory = build_x509_provider,
    http: AwsHttpPost | None = None,
) -> list[ProbeResult]:
    """Runs the six video checks with the robot's identity and returns their results.

    If the robot's own credentials cannot be obtained, every check fails with
    `NOT_AUTHENTICATED` and nothing else is sent. If the positive control on the robot's own
    channel does not succeed, the three channel checks fail with `CONTROL_FAILED`, because a
    refusal would prove nothing then.

    Args:
        kit: The robot's loaded kit. Its identity and channel are the ones probed.
        other_robot_id: The other robot, whose channel and credentials must be refused.
        other_channel_arn: The other robot's real channel ARN, when the synthetic one is not
            enough. Already validated by `other_channel_arn_for`.
        provider_factory: Builds the credentials provider of a kit. Injected for tests.
        http: Sends the signed requests. Defaults to the standard library sender.

    Returns:
        One result per check, in the order the checks run.

    Raises:
        KitError: With `KIT_KEY_INVALID` when the TLS context refuses the certificate or key.
    """
    sender: AwsHttpPost = http if http is not None else UrllibAwsHttpPost()
    other_thing_name = f"{THING_NAME_PREFIX}{other_robot_id}"
    try:
        own_source = X509CredentialsSource(kit, provider_factory=provider_factory)
        other_source = X509CredentialsSource(
            _kit_with_thing_name(kit, other_thing_name), provider_factory=provider_factory
        )
    except (AwsCrtError, RuntimeError, TypeError, ValueError):
        # Same reasoning as the MQTT transport: every refusal of the TLS material means one thing.
        raise KitError("KIT_KEY_INVALID") from None

    try:
        own = await own_source.fetch()
    except CredentialsError:
        return [_result(name, expected, _NOT_AUTHENTICATED) for name, expected in _CHECK_ORDER]

    region = kit.config.region
    own_arn = kit.config.kvs_channel_arn
    account = own_arn.split(":")[_KVS_ARN_ACCOUNT_INDEX]
    arn = other_channel_arn or (
        f"arn:aws:kinesisvideo:{region}:{account}:channel/{other_thing_name}/"
        f"{_OTHER_CHANNEL_TIMESTAMP_MS}"
    )

    control = await _endpoint_check(sender, region, own, own_arn, _MASTER)
    results = [
        _result(_CHECK_ORDER[0][0], "ALLOWED", _CREDENTIALS_OK),
        _result(_CHECK_ORDER[1][0], "ALLOWED", control),
    ]
    if control == _HTTP_200:
        results.append(
            _result(
                _CHECK_ORDER[2][0],
                "DENIED",
                await _endpoint_check(sender, region, own, arn, _MASTER),
            )
        )
        results.append(
            _result(
                _CHECK_ORDER[3][0],
                "DENIED",
                await _endpoint_check(sender, region, own, arn, _VIEWER),
            )
        )
        results.append(
            _result(
                _CHECK_ORDER[4][0],
                "DENIED",
                await _describe_check(sender, region, own, own_arn),
            )
        )
    else:
        results.extend(_result(name, "DENIED", _CONTROL_FAILED) for name, _ in _CHECK_ORDER[2:5])
    results.append(
        _result(
            _CHECK_ORDER[5][0],
            "DENIED",
            await _other_credentials_check(other_source, own_source),
        )
    )
    return results


def _result(name: str, expected: Expected, observed: str) -> ProbeResult:
    """Builds one result, deciding whether the observation matches the expectation.

    Args:
        name: The check's name.
        expected: What the policy must do.
        observed: The fixed label of what happened.

    Returns:
        The result of the check.
    """
    accepted = _ALLOWED_LABELS if expected == "ALLOWED" else _DENIED_LABELS
    return ProbeResult(
        check=name,
        expected=expected,
        observed=observed,
        passed=observed in accepted,
    )


def _kit_with_thing_name(kit: LoadedKit, thing_name: str) -> LoadedKit:
    """Returns the same kit under another thing name, which the provider sends as its identity.

    The certificate and the key stay the robot's own: the point of the check is that the
    credentials service must refuse them under another name.

    Args:
        kit: The robot's loaded kit.
        thing_name: The thing name to present.

    Returns:
        The kit with the other thing name.
    """
    config = kit.config.model_copy(update={"thing_name": thing_name})
    return LoadedKit(config=config, tls=kit.tls, kit_dir=kit.kit_dir)


async def _endpoint_check(
    sender: AwsHttpPost,
    region: str,
    creds: VideoCredentials,
    channel_arn: str,
    role: Literal["MASTER", "VIEWER"],
) -> str:
    """Asks for the signalling endpoint of a channel in a role, and labels the answer.

    Args:
        sender: Sends the signed request.
        region: The kit's region, which names the endpoint host.
        creds: The robot's own temporary credentials.
        channel_arn: The channel to ask for.
        role: The role to ask for.

    Returns:
        The fixed label of the answer.
    """
    body = {
        "ChannelARN": channel_arn,
        "SingleMasterChannelEndpointConfiguration": {
            "Protocols": ["WSS", "HTTPS"],
            "Role": role,
        },
    }
    return await _signed_post(sender, region, creds, _GET_ENDPOINT_PATH, body)


async def _describe_check(
    sender: AwsHttpPost,
    region: str,
    creds: VideoCredentials,
    channel_arn: str,
) -> str:
    """Describes a channel with the robot's own credentials, and labels the answer.

    Args:
        sender: Sends the signed request.
        region: The kit's region, which names the endpoint host.
        creds: The robot's own temporary credentials.
        channel_arn: The channel to describe.

    Returns:
        The fixed label of the answer.
    """
    return await _signed_post(sender, region, creds, _DESCRIBE_PATH, {"ChannelARN": channel_arn})


async def _other_credentials_check(
    other: X509CredentialsSource,
    own: X509CredentialsSource,
) -> str:
    """Asks for credentials under another thing name, and labels the refusal.

    A provider failure is a refusal only if the network was up: the robot's own credentials are
    fetched again right after it, and must succeed. If that fetch fails, the failure may have been
    the network, not the policy, so the check is inconclusive and fails.

    Args:
        other: The source built with the other thing name.
        own: The robot's own source, used for the re-fetch that proves the network was up.

    Returns:
        `CREDENTIALS_OK` when the service granted them, `PROVIDER_REFUSED` when the provider
        failed and the robot's own credentials were fetched again, `INCONCLUSIVE` when that
        re-fetch failed too, or `UNEXPECTED` for any other failure.
    """
    try:
        await other.fetch()
    except CredentialsError as err:
        if err.code != "PROVIDER_FAILED":
            return _UNEXPECTED
        try:
            await own.fetch()
        except CredentialsError:
            return _INCONCLUSIVE
        return _PROVIDER_REFUSED
    return _CREDENTIALS_OK


async def _signed_post(
    sender: AwsHttpPost,
    region: str,
    creds: VideoCredentials,
    path: str,
    body: Mapping[str, object],
) -> str:
    """Signs and sends one request off the event loop, and labels the answer.

    The blocking signature wait and the blocking HTTP call run in a worker thread, so the probe
    never stalls the loop of the caller.

    Args:
        sender: Sends the signed request.
        region: The kit's region, which names the endpoint host and the signing region.
        creds: The robot's own temporary credentials.
        path: The operation's path.
        body: The JSON body, serialised once and covered by the signature.

    Returns:
        The fixed label of the answer.
    """
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    try:
        reply = await asyncio.to_thread(_send_signed, sender, region, creds, path, payload)
    except AwsCrtError:
        return _SIGNING_FAILED
    except OSError:
        return _NETWORK_ERROR
    return _classify(reply)


def _send_signed(
    sender: AwsHttpPost,
    region: str,
    creds: VideoCredentials,
    path: str,
    payload: bytes,
) -> HttpReply:
    """Signs one request with awscrt and sends it.

    Args:
        sender: Sends the signed request.
        region: The kit's region.
        creds: The robot's own temporary credentials.
        path: The operation's path.
        payload: The serialised JSON body.

    Returns:
        The status and error type of the response.

    Raises:
        AwsCrtError: If awscrt cannot sign the request.
        OSError: If the request cannot be completed.
    """
    host = f"kinesisvideo.{region}.amazonaws.com"
    request = HttpRequest(
        method="POST",
        path=path,
        headers=HttpHeaders([("Host", host), ("Content-Type", "application/json")]),
    )
    provider = AwsCredentialsProvider.new_static(
        creds.access_key_id,
        creds.secret_access_key,
        creds.session_token,
    )
    config = AwsSigningConfig(
        algorithm=AwsSigningAlgorithm.V4,
        signature_type=AwsSignatureType.HTTP_REQUEST_HEADERS,
        credentials_provider=provider,
        region=region,
        service=_SERVICE,
        signed_body_value=hashlib.sha256(payload).hexdigest(),
    )
    signed = aws_sign_request(request, config).result(timeout=_SIGNATURE_TIMEOUT_S)
    headers = dict(signed.headers)
    return sender.post(f"https://{host}{path}", headers, payload)


def _classify(reply: HttpReply) -> str:
    """Labels a response: success, the expected denial, an inconclusive not-found, or other.

    A 404 is never a denial: the policy did not get to decide, so it is inconclusive and fails.

    Args:
        reply: The status and error type of the response.

    Returns:
        The fixed label.
    """
    error_type = reply.error_type or ""
    if reply.status == 200:
        return _HTTP_200
    if reply.status == 403 and error_type.startswith(_ACCESS_DENIED):
        return _ACCESS_DENIED_LABEL
    if reply.status == 404 and error_type.startswith(_RESOURCE_NOT_FOUND):
        return _INCONCLUSIVE
    return _UNEXPECTED
