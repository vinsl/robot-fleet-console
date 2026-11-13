"""Creates or resets an Operator or Viewer account from the demo control page (ADR 0076).

The page never talks to Cognito itself. Every change runs `scripts/bootstrap-admin.sh` with the
operator's own session, the same script that `make bootstrap-admin` runs, so the password handling
and the group rules stay in one place. This module decides whether a change may run at all, runs it
once, and turns the script's answer into a result or a fixed error code.

Admin accounts are never created or reset from the page, an existing account never gains a group,
and a reset never changes a role. The temporary password leaves this module only in the result of
one write, and it appears in no log line, no `repr` and no error.
"""

from __future__ import annotations

import logging
import re
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, field_validator

from fleet_agent.demo_ui.aws_reads import MAX_USERS, AwsReader, UserRow
from fleet_agent.demo_ui.config import Settings
from fleet_agent.demo_ui.demo import Clock
from fleet_agent.demo_ui.errors import DemoError, failure_of
from fleet_agent.demo_ui.runner import CommandResult, CommandRunner, minimal_env

logger = logging.getLogger(__name__)

EMAIL_PATTERN: Final = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9._%+-]*"
    r"@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*"
    r"\.[A-Za-z]{2,}"
)
"""The e-mail grammar the page accepts: a strict ASCII subset of the script's own check.

The first character is a letter or a digit, so the address can never start with `-` and be read as
an option of the AWS CLI. The match is always a full match, so a trailing newline is refused too.
"""

MAX_EMAIL_LENGTH: Final = 128
"""Cognito limits a username to 128 characters."""

PASSWORD_PATTERN: Final = re.compile(r"[A-Za-z0-9+/]{24}Aa1!")
"""The shape of a temporary password printed by the script: 24 base64 characters and its suffix."""

ACCOUNT_TIMEOUT_S: Final = 90.0
"""Longest time a script run may take: the password and the group are two Cognito calls."""

MAX_WRITES: Final = 5
WRITE_WINDOW_S: Final = 600.0
"""At most `MAX_WRITES` account writes in any `WRITE_WINDOW_S` seconds, failures included."""

TEMPORARY_PASSWORD_HOURS: Final = 24
"""Validity of a temporary password, as the script's own message states."""

AccountRole = Literal["Operator", "Viewer"]
"""The only roles the page creates. Admin is never accepted."""

HEADER_TEMPLATE: Final = "Temporary password for the {role} account, shown once and stored nowhere:"
"""The line the script prints before the password. Its text is pinned by a contract test."""
_SIGN_IN_LINE: Final = "The user signs in"

_PROTECTED_ROLES: Final = frozenset({"Admin", "none"})


class AccountBody(BaseModel):
    """The body of a POST to the accounts route. Unknown fields are refused.

    Attributes:
        email: The account's e-mail address, which is also its username.
        role: The role of the account. Admin is not in the grammar.
        reset: False to create an account, True to issue a new temporary password to an existing
            one.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    email: str
    role: AccountRole
    reset: bool = False

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value: str) -> str:
        """Checks the length and the grammar of the address.

        Args:
            value: The address as sent.

        Returns:
            The address, unchanged.

        Raises:
            ValueError: When the address is too long or outside the grammar. The message is not
            returned to the client, so it never echoes the address.
        """
        if len(value) > MAX_EMAIL_LENGTH or EMAIL_PATTERN.fullmatch(value) is None:
            raise ValueError("invalid e-mail address")
        return value


@dataclass(frozen=True)
class AccountResult:
    """The answer of a successful write.

    Attributes:
        outcome: `created` for a new account, `reset` for a new temporary password.
        role: The role of the account after the write.
        temporary_password: The password, shown once. It is excluded from `repr`.
    """

    outcome: Literal["created", "reset"]
    role: AccountRole
    temporary_password: str = field(repr=False)


def parse_script_output(stdout: str, role: AccountRole) -> str | None:
    """Reads the temporary password from the script's standard output.

    The parser fails closed: anything other than the three lines the script prints is refused, so a
    changed or noisy script never yields a password this page did not expect.

    Args:
        stdout: The standard output of a successful script run.
        role: The role the run was asked for; the header names it.

    Returns:
        The password, or None when the output does not have the expected shape.
    """
    lines = stdout.splitlines()
    if len(lines) != 3:
        return None
    if lines[0] != HEADER_TEMPLATE.format(role=role):
        return None
    if PASSWORD_PATTERN.fullmatch(lines[1]) is None:
        return None
    if not lines[2].startswith(_SIGN_IN_LINE):
        return None
    return lines[1]


def classify_script_failure(result: CommandResult, reset: bool) -> DemoError:
    """Maps a failed script run to the error code the page shows.

    The script's own messages are matched by fixed fragments (see `scripts/bootstrap-admin.sh`).
    Anything else goes through the shared AWS classification, so a missing permission is named.

    Args:
        result: The failed run.
        reset: True for a reset, which names its own IAM action in a permission message.

    Returns:
        The error to raise. Its message is always a fixed text.
    """
    if result.timed_out:
        return DemoError("ACCOUNT_TIMEOUT")
    stderr = result.stderr
    # The script's text is checked before the shared classification: its "AWS session" wording is
    # not one of the expired-session markers, so the match must be explicit.
    if "no AWS session" in stderr:
        return DemoError("NO_SESSION")
    if "Terraform outputs" in stderr:
        return DemoError("STACK_UNAVAILABLE")
    if "was created but its group" in stderr or "sessions could not be signed out" in stderr:
        return DemoError("ACCOUNT_PARTIAL")
    action = "cognito-idp:AdminSetUserPassword" if reset else "cognito-idp:AdminCreateUser"
    return failure_of(result, action, "ACCOUNT_FAILED")


def _matching_account(rows: list[UserRow], email: str) -> UserRow | None:
    """Finds the account of an e-mail address, ignoring the case.

    Args:
        rows: The accounts of the pool.
        email: The address, already checked by the grammar.

    Returns:
        The account, or None when the pool has none.
    """
    wanted = email.lower()
    return next((row for row in rows if row.username_display.lower() == wanted), None)


class AccountWriter:
    """Runs one account change at a time, within the rate limit, after the rules are checked.

    The writer keeps no password and no e-mail: its only state is the lock and the times of the
    recent writes.
    """

    def __init__(
        self,
        *,
        runner: CommandRunner,
        aws: AwsReader,
        settings: Settings,
        clock: Clock,
    ) -> None:
        """Creates the writer.

        Args:
            runner: Runs the script.
            aws: Lists the accounts of the pool before any change.
            settings: The script paths of the page.
            clock: The time source of the rate limit. Tests inject a clock that moves when told.
        """
        self._runner = runner
        self._aws = aws
        self._settings = settings
        self._clock = clock
        # Non-blocking: a second request while one change runs is refused, never queued.
        self._lock = threading.Lock()
        self._recent: deque[float] = deque()

    def write(self, body: AccountBody) -> AccountResult:
        """Creates the account, or issues a new temporary password to it.

        Args:
            body: The validated request.

        Returns:
            The result, with the temporary password.

        Raises:
            DemoError: With the code of the refusal or of the failure. Never a message built from
            the script's output.
        """
        if not self._lock.acquire(blocking=False):
            raise DemoError("IN_PROGRESS")
        try:
            return self._locked_write(body)
        finally:
            self._lock.release()

    def _locked_write(self, body: AccountBody) -> AccountResult:
        """Runs one write while the lock is held, and logs exactly one line for it.

        Args:
            body: The validated request.

        Returns:
            The result of the write.

        Raises:
            DemoError: With the code of the refusal or of the failure.
        """
        outcome = "ERROR"
        returncode: int | None = None
        try:
            self._record_attempt()
            rows = self._aws.list_users()
            if len(rows) >= MAX_USERS:
                # The list is capped: a larger pool cannot be checked for duplicates, so refuse.
                raise DemoError("POOL_TOO_LARGE")
            self._check_rules(body, _matching_account(rows, body.email))
            result = self._runner.run(
                ["bash", str(self._settings.script("bootstrap-admin.sh")), body.email],
                timeout_s=ACCOUNT_TIMEOUT_S,
                env=minimal_env(
                    extra={"ROLE": body.role, "RESET": "1" if body.reset else "0"},
                ),
            )
            returncode = result.returncode
            answer = self._answer(result, body)
            outcome = answer.outcome
            return answer
        except DemoError as failure:
            outcome = failure.code
            raise
        finally:
            # Only the mode, the role, the outcome and the return code: never the address, the
            # password or the script's output.
            logger.info(
                "account write mode=%s role=%s outcome=%s rc=%s",
                "reset" if body.reset else "create",
                body.role,
                outcome,
                returncode,
            )

    def _record_attempt(self) -> None:
        """Enforces the rate limit and records this attempt.

        Raises:
            DemoError: With `RATE_LIMITED` when the window already holds `MAX_WRITES` attempts.
        """
        now = self._clock.now()
        while self._recent and now - self._recent[0] > WRITE_WINDOW_S:
            self._recent.popleft()
        if len(self._recent) >= MAX_WRITES:
            raise DemoError("RATE_LIMITED")
        # Failures count too: a retry loop must not become a way around the limit.
        self._recent.append(now)

    def _check_rules(self, body: AccountBody, account: UserRow | None) -> None:
        """Checks the rules of a change against the account the pool holds, if any.

        Args:
            body: The request.
            account: The pool's account of the address, or None.

        Raises:
            DemoError: USER_EXISTS, USER_NOT_FOUND, ACCOUNT_PROTECTED or ROLE_MISMATCH.
        """
        if not body.reset:
            if account is not None:
                raise DemoError("USER_EXISTS")
            return
        if account is None:
            raise DemoError("USER_NOT_FOUND")
        if account.role in _PROTECTED_ROLES or not account.enabled:
            raise DemoError("ACCOUNT_PROTECTED")
        if account.role != body.role:
            raise DemoError("ROLE_MISMATCH")

    def _answer(self, result: CommandResult, body: AccountBody) -> AccountResult:
        """Turns the script's run into a result or a fixed error.

        Args:
            result: The run.
            body: The request, which says whether it was a reset.

        Returns:
            The result of a successful run.

        Raises:
            DemoError: With the code that matches the run.
        """
        if result.timed_out:
            raise DemoError("ACCOUNT_TIMEOUT")
        if result.returncode == 0:
            password = parse_script_output(result.stdout, body.role)
            if password is not None:
                outcome: Literal["created", "reset"] = "reset" if body.reset else "created"
                return AccountResult(outcome=outcome, role=body.role, temporary_password=password)
            # A create that exits 0 without a password means the account appeared since the check:
            # the script then only reports it. A retried create lands here too, and never gets a
            # second password by accident.
            if not body.reset and result.stdout.strip() == "":
                raise DemoError("USER_EXISTS")
            raise DemoError("INTERNAL")
        if result.returncode == 1:
            raise classify_script_failure(result, body.reset)
        raise DemoError("INTERNAL")
