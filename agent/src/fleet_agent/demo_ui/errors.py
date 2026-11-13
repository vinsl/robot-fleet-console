"""Stable error codes of the demo control page, and the classification of failed AWS CLI calls.

The page never shows the text of a tool's error output: it maps the output to one of these codes and
a fixed message, so no account id, ARN or path can reach the browser. The details stay in the local
log.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, Literal

from fleet_agent.demo_ui.runner import CommandResult

ErrorCode = Literal[
    "NO_SESSION",
    "PERMISSION_DENIED",
    "AWS_UNAVAILABLE",
    "STACK_UNAVAILABLE",
    "CONSUMER_FAILED",
    "PROVISION_FAILED",
    "SIM_FAILED",
    "STOP_TIMEOUT",
    "IN_PROGRESS",
    "UNKNOWN_SITE",
    "INTERNAL",
    "INVALID_BODY",
    "INVALID_EMAIL",
    "INVALID_ROLE",
    "USER_EXISTS",
    "USER_NOT_FOUND",
    "ROLE_MISMATCH",
    "ACCOUNT_PROTECTED",
    "RATE_LIMITED",
    "POOL_TOO_LARGE",
    "ACCOUNT_FAILED",
    "ACCOUNT_PARTIAL",
    "ACCOUNT_TIMEOUT",
]
"""Every code the page can report. Each one maps to one fixed message."""

ERROR_MESSAGES: Final[Mapping[ErrorCode, str]] = MappingProxyType(
    {
        "NO_SESSION": (
            "The AWS session has expired or is missing. "
            "Run `aws sso login` in a terminal, then retry."
        ),
        "PERMISSION_DENIED": "The AWS session lacks a permission this page needs.",
        "AWS_UNAVAILABLE": (
            "AWS did not answer in time or throttled the request. Retry in a moment."
        ),
        "STACK_UNAVAILABLE": "The demo stack outputs are unavailable. Deploy the stack first.",
        "CONSUMER_FAILED": (
            "The ingest consumer could not be changed. Check the AWS session, then retry."
        ),
        "PROVISION_FAILED": (
            "The simulated robots could not be registered. The local log has the details."
        ),
        "SIM_FAILED": "The simulators did not start. The local log has the details.",
        "STOP_TIMEOUT": (
            "The simulators did not stop within the grace period. Check them on this machine."
        ),
        "IN_PROGRESS": "Another change is already running.",
        "UNKNOWN_SITE": "Unknown site.",
        "INTERNAL": "Unexpected error. The local log has the details.",
        "INVALID_BODY": "The request body is not valid.",
        "INVALID_EMAIL": "The e-mail address is not valid.",
        "INVALID_ROLE": "The role must be Operator or Viewer.",
        "USER_EXISTS": (
            "An account with this e-mail already exists. "
            "Use reset to issue a new temporary password."
        ),
        "USER_NOT_FOUND": "No account with this e-mail exists in the pool.",
        "ROLE_MISMATCH": (
            "The account has another role. Pick the role it already has to reset it."
        ),
        "ACCOUNT_PROTECTED": (
            "This account cannot be reset from this page: "
            "it is an Admin, has no role or is disabled."
        ),
        "RATE_LIMITED": (
            "Too many account changes in the last ten minutes. Wait a few minutes, then retry."
        ),
        "POOL_TOO_LARGE": (
            "The pool has too many accounts for this page to check. Run make bootstrap-admin "
            "in a terminal."
        ),
        "ACCOUNT_FAILED": "The account could not be changed. The local log has the details.",
        "ACCOUNT_PARTIAL": (
            "The account change stopped half way. "
            "Run make bootstrap-admin with RESET=1 in a terminal."
        ),
        "ACCOUNT_TIMEOUT": (
            "The account change did not finish in time. Check the user list before retrying."
        ),
    }
)
"""Fixed, generic message of each code. Never built from tool output."""

EXPIRED_MARKERS: Final[tuple[str, ...]] = (
    "expiredtoken",
    "token has expired",
    "unable to locate credentials",
    "sso session",
    "error loading sso token",
)
"""Fragments of AWS CLI error output that mean the local session is missing or expired."""

DENIED_MARKERS: Final[tuple[str, ...]] = (
    "accessdenied",
    "access denied",
    "not authorized to perform",
    "unauthorizedoperation",
)
"""Fragments of AWS CLI error output that mean the session lacks an IAM permission."""


@dataclass(frozen=True)
class ProblemInfo:
    """An error as the page shows it: a stable code and its fixed message."""

    code: ErrorCode
    message: str


class DemoError(Exception):
    """A failure the page reports to the operator. The message is always a fixed text."""

    def __init__(self, code: ErrorCode, message: str | None = None) -> None:
        """Creates the error with the fixed message of its code unless a message is given.

        Args:
            code: The stable code.
            message: A fixed text that names a permission, when one is needed.
        """
        self.code: ErrorCode = code
        self.message: str = ERROR_MESSAGES[code] if message is None else message
        super().__init__(self.message)

    def problem(self) -> ProblemInfo:
        """Returns the error as a problem for the page.

        Returns:
            The code and the message.
        """
        return ProblemInfo(code=self.code, message=self.message)


def failure_of(result: CommandResult, action: str, fallback: ErrorCode) -> DemoError:
    """Classifies a failed AWS CLI or script call without copying its output.

    Args:
        result: The failed call.
        action: The IAM action the call needed, named in the message when it is denied. Only
        constants.
        fallback: The code for any other failure.

    Returns:
        The error to raise. A timeout is always `AWS_UNAVAILABLE`.
    """
    if result.timed_out:
        return DemoError("AWS_UNAVAILABLE")
    text = result.stderr.lower()
    if any(marker in text for marker in EXPIRED_MARKERS):
        return DemoError("NO_SESSION")
    if any(marker in text for marker in DENIED_MARKERS):
        return DemoError("PERMISSION_DENIED", f"The AWS session lacks the permission {action}.")
    return DemoError(fallback)
