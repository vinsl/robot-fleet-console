"""Read-only AWS queries of the demo control page: session, users, robots and the consumer.

Every call runs through the `aws` CLI with the operator's own session, and only reads. The answers
are parsed into the small row types below, and nothing else is kept: the page never sees a password,
a key, an ARN or an account id, because the row types have no field for them and the parsers ignore
every other field.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from fleet_agent.demo_ui.config import Settings
from fleet_agent.demo_ui.errors import DemoError, failure_of
from fleet_agent.demo_ui.outputs import OutputsSource, StackOutputs
from fleet_agent.demo_ui.runner import CommandResult, CommandRunner

SESSION_TIMEOUT_S: Final = 8.0
"""Longest time for the caller-identity check. A timeout means the session cannot be used now."""

READ_TIMEOUT_S: Final = 15.0
CONSUMER_TIMEOUT_S: Final = 30.0
USER_PAGE_SIZE: Final = 60
"""Largest page the Cognito list calls accept."""

MAX_USERS: Final = 200
MAX_PAGES: Final = 4
"""Pages read per list call. With 60 users a page, four pages are more than the cap of 200 users."""

MAX_ROBOTS: Final = 200
LIVE_STALE_MS: Final = 120_000
"""A live state older than this is shown as offline: an OFFLINE mark may never have been written."""

ROBOT_ID: Final = re.compile(r"^[a-z0-9-]{3,32}$")
SITE_ID: Final = re.compile(r"^[a-z0-9-]{3,32}$")
CONSUMER_STATE: Final = re.compile(r"^[A-Za-z]{1,32}$")

Role = Literal["Admin", "Operator", "Viewer", "none"]
"""Role of a user: the highest of the groups the user belongs to, or `none`."""

GROUPS: Final[tuple[Literal["Admin", "Operator", "Viewer"], ...]] = ("Admin", "Operator", "Viewer")
"""The Cognito groups, from the highest role to the lowest."""

RobotKind = Literal["simulated", "real"]
Connection = Literal["online", "offline", "unknown"]


@dataclass(frozen=True)
class SessionStatus:
    """Whether the operator's AWS session works. No account identifier is kept."""

    valid: bool


@dataclass(frozen=True)
class UserRow:
    """One operator account, as the page shows it. There is no field for any secret."""

    username_display: str
    role: Role
    status: str
    enabled: bool


@dataclass(frozen=True)
class RobotRow:
    """One robot of a site: its registry entry and its last live state, when one exists."""

    robot_id: str
    name: str
    kind: RobotKind
    registry_status: str
    connection: Connection
    last_seen: str | None


class _Attribute(BaseModel):
    """One Cognito attribute. Only the name and the value are read."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    name: str = Field(alias="Name")
    value: str | None = Field(default=None, alias="Value")


class _CognitoUser(BaseModel):
    """One user of `cognito-idp list-users`. Other fields of the response are ignored."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: str = Field(alias="Username")
    attributes: list[_Attribute] = Field(default_factory=list, alias="Attributes")
    enabled: bool = Field(default=False, alias="Enabled")
    user_status: str = Field(default="UNKNOWN", alias="UserStatus")


class _ListUsersPage(BaseModel):
    """One page of `cognito-idp list-users`."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    users: list[_CognitoUser] = Field(default_factory=list, alias="Users")
    pagination_token: str | None = Field(default=None, alias="PaginationToken")


class _GroupMember(BaseModel):
    """One member of `cognito-idp list-users-in-group`."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: str = Field(alias="Username")


class _GroupPage(BaseModel):
    """One page of `cognito-idp list-users-in-group`."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    users: list[_GroupMember] = Field(default_factory=list, alias="Users")
    next_token: str | None = Field(default=None, alias="NextToken")


class _Scalar(BaseModel):
    """One DynamoDB attribute value as the CLI prints it, for example {"S": "text"}."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    text: str | None = Field(default=None, alias="S")
    flag: bool | None = Field(default=None, alias="BOOL")
    number: str | None = Field(default=None, alias="N")


class _QueryPage(BaseModel):
    """One DynamoDB query result. Items keep their typed attribute values."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    # Values stay untyped here: each attribute is validated only when it is read.
    items: list[dict[str, object]] = Field(default_factory=list, alias="Items")


def _now_ms() -> int:
    """Reads the wall clock in milliseconds.

    Returns:
        Milliseconds since the Unix epoch.
    """
    return int(time.time() * 1000)


def _iso_from_ms(milliseconds: int) -> str:
    """Formats a time for the page.

    Args:
        milliseconds: Milliseconds since the Unix epoch.

    Returns:
        The UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
    """
    return datetime.fromtimestamp(milliseconds / 1000, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse[ModelT: BaseModel](text: str, model: type[ModelT], action: str) -> ModelT:
    """Validates the JSON of a CLI answer. A malformed answer is an AWS failure, not a crash.

    Args:
        text: The standard output of the command.
        model: The expected shape.
        action: The IAM action, named in the message when the answer is not understood.

    Returns:
        The validated answer.

    Raises:
        DemoError: When the answer does not match the shape.
    """
    try:
        return model.model_validate_json(text)
    except ValueError as error:
        # The action name is a constant of this module; the answer itself is never included.
        raise DemoError("AWS_UNAVAILABLE", f"The answer of {action} was not understood.") from error


class AwsReader:
    """Read-only queries over the operator's AWS session. Every method may raise `DemoError`."""

    def __init__(
        self,
        runner: CommandRunner,
        settings: Settings,
        outputs: OutputsSource,
        clock_ms: Callable[[], int] = _now_ms,
    ) -> None:
        """Creates the reader.

        Args:
            runner: Runs the `aws` CLI and the consumer script.
            settings: The settings of the page (the script paths and the site).
            outputs: Gives the table and the pool names.
            clock_ms: The wall clock, in milliseconds. Tests inject a fixed one.
        """
        self._runner = runner
        self._settings = settings
        self._outputs = outputs
        self._clock_ms = clock_ms

    def _read(self, argv: list[str], timeout_s: float, action: str) -> str:
        """Runs one read and returns its standard output, or raises the classified failure.

        Args:
            argv: The `aws` command.
            timeout_s: Its time limit.
            action: The IAM action it needs, named in a permission failure.

        Returns:
            The standard output.

        Raises:
            DemoError: When the call fails.
        """
        result: CommandResult = self._runner.run(argv, timeout_s=timeout_s)
        if result.returncode != 0 or result.timed_out:
            raise failure_of(result, action, "AWS_UNAVAILABLE")
        return result.stdout

    def session_identity(self) -> SessionStatus:
        """Checks that the operator's session works. The account and the ARN are not returned.

        Returns:
            Whether the caller identity call succeeded.
        """
        result = self._runner.run(
            ["aws", "sts", "get-caller-identity", "--output", "json"],
            timeout_s=SESSION_TIMEOUT_S,
        )
        return SessionStatus(valid=result.returncode == 0 and not result.timed_out)

    def consumer_state(self) -> str:
        """Reads the state of the ingest consumer through `scripts/demo-consumer.sh status`.

        Returns:
            The state word (for example `Enabled`), or `unknown` when the script fails or
            prints anything else.
        """
        result = self._runner.run(
            ["bash", str(self._settings.script("demo-consumer.sh")), "status"],
            timeout_s=CONSUMER_TIMEOUT_S,
        )
        text = result.stdout.strip()
        if result.returncode != 0 or CONSUMER_STATE.fullmatch(text) is None:
            return "unknown"
        return text

    def list_users(self) -> list[UserRow]:
        """Lists the pool's accounts with their role, at most 200, sorted by display name.

        Returns:
            The users. A user in no group has role `none`.

        Raises:
            DemoError: When Cognito cannot be read or the session lacks a permission.
        """
        stack = self._outputs.get()
        accounts = self._pool_users(stack)
        members = {group: self._group_members(stack, group) for group in GROUPS}
        rows: list[UserRow] = []
        for account in accounts:
            role: Role = "none"
            for group in GROUPS:
                if account.username in members[group]:
                    role = group
                    break
            rows.append(
                UserRow(
                    username_display=_display_name(account),
                    role=role,
                    status=account.user_status,
                    enabled=account.enabled,
                )
            )
        return sorted(rows, key=lambda row: row.username_display.lower())

    def _pool_users(self, stack: StackOutputs) -> list[_CognitoUser]:
        """Reads the users of the pool, page by page, up to the cap.

        Args:
            stack: The stack outputs (pool and region).

        Returns:
            At most `MAX_USERS` users.
        """
        users: list[_CognitoUser] = []
        token: str | None = None
        for _ in range(MAX_PAGES):
            argv = [
                "aws",
                "cognito-idp",
                "list-users",
                "--user-pool-id",
                stack.user_pool_id,
                "--region",
                stack.region,
                "--limit",
                str(USER_PAGE_SIZE),
                "--output",
                "json",
            ]
            if token is not None:
                # One argument per option: a token can never be read as another option.
                argv += [f"--pagination-token={token}"]
            page = _parse(
                self._read(argv, READ_TIMEOUT_S, "cognito-idp:ListUsers"),
                _ListUsersPage,
                "cognito-idp:ListUsers",
            )
            users.extend(page.users)
            token = page.pagination_token
            if token is None or len(users) >= MAX_USERS:
                break
        return users[:MAX_USERS]

    def _group_members(self, stack: StackOutputs, group: str) -> set[str]:
        """Lists the usernames of one Cognito group, page by page.

        Args:
            stack: The stack outputs (pool and region).
            group: The group name, from `GROUPS`.

        Returns:
            The usernames of the group.
        """
        members: set[str] = set()
        token: str | None = None
        for _ in range(MAX_PAGES):
            argv = [
                "aws",
                "cognito-idp",
                "list-users-in-group",
                "--user-pool-id",
                stack.user_pool_id,
                "--group-name",
                group,
                "--region",
                stack.region,
                "--limit",
                str(USER_PAGE_SIZE),
                "--output",
                "json",
            ]
            if token is not None:
                argv += [f"--next-token={token}"]
            page = _parse(
                self._read(argv, READ_TIMEOUT_S, "cognito-idp:ListUsersInGroup"),
                _GroupPage,
                "cognito-idp:ListUsersInGroup",
            )
            members.update(member.username for member in page.users)
            token = page.next_token
            if token is None:
                break
        return members

    def list_robots(self, site_id: str) -> list[RobotRow]:
        """Lists the robots of a site from the registry, with the connection from the live state.

        The connection is `unknown` when no live state exists, `offline` when the last state is
        OFFLINE or stale, and `online` otherwise. The kit and the registration response are never
        read.

        Args:
            site_id: The site, checked against its grammar before any call.

        Returns:
            At most 200 robots, sorted by identifier. Items that do not match the expected
            shape are left out.

        Raises:
            DemoError: When the registry cannot be read or the session lacks a permission.
            ValueError: When the site identifier does not match its grammar.
        """
        if SITE_ID.fullmatch(site_id) is None:
            raise ValueError("the site identifier does not match its grammar")
        stack = self._outputs.get()
        registry = _parse(
            self._read(
                self._query_argv(
                    stack,
                    partition=f"SITE#{site_id}",
                    prefix="ROBOT#",
                    projection={
                        "#rid": "robotId",
                        "#nm": "name",
                        "#sim": "simulated",
                        "#st": "status",
                    },
                ),
                READ_TIMEOUT_S,
                "dynamodb:Query",
            ),
            _QueryPage,
            "dynamodb:Query",
        )
        live = self._live_states(stack, site_id)
        now = self._clock_ms()
        rows: list[RobotRow] = []
        for item in registry.items[:MAX_ROBOTS]:
            row = _robot_row(item, live, now)
            # A retired robot stays in the registry for its history and its never-reused id,
            # but it is no longer a robot of the fleet, so the page does not list it.
            if row is not None and row.registry_status != "RETIRED":
                rows.append(row)
        return sorted(rows, key=lambda row: row.robot_id)

    def _live_states(self, stack: StackOutputs, site_id: str) -> dict[str, tuple[str, int]]:
        """Reads the last live state of each robot of a site.

        A permission failure is an error. Any other failure leaves the connections `unknown`, so the
        robot list still shows the registry.

        Args:
            stack: The stack outputs.
            site_id: The site.

        Returns:
            For each robot identifier, its state word and the time it was received
            (milliseconds).

        Raises:
            DemoError: When the session lacks the permission to read the table.
        """
        try:
            page = _parse(
                self._read(
                    self._query_argv(
                        stack,
                        partition=f"SITE#{site_id}",
                        prefix="STATE#",
                        projection={"#rid": "robotId", "#st": "state", "#rc": "receivedAt"},
                    ),
                    READ_TIMEOUT_S,
                    "dynamodb:Query",
                ),
                _QueryPage,
                "dynamodb:Query",
            )
        except DemoError as error:
            if error.code == "PERMISSION_DENIED":
                raise
            return {}
        states: dict[str, tuple[str, int]] = {}
        for item in page.items:
            robot_id = _text(item, "robotId")
            state = _text(item, "state")
            received = _text(item, "receivedAt")
            if robot_id is None or state is None or received is None or not received.isdigit():
                continue
            states[robot_id] = (state, int(received))
        return states

    def _query_argv(
        self,
        stack: StackOutputs,
        *,
        partition: str,
        prefix: str,
        projection: dict[str, str],
    ) -> list[str]:
        """Builds one DynamoDB query; values travel as JSON attributes, never in the expression.

        Args:
            stack: The stack outputs (table and region).
            partition: The partition key value.
            prefix: The sort key prefix.
            projection: Expression attribute names mapped to the attribute names they stand for.

        Returns:
            The `aws dynamodb query` argument list, with one page of at most 200 items and no
            auto-pagination.
        """
        values = {":pk": {"S": partition}, ":prefix": {"S": prefix}}
        return [
            "aws",
            "dynamodb",
            "query",
            "--table-name",
            stack.fleet_table_name,
            "--region",
            stack.region,
            "--key-condition-expression",
            "pk = :pk AND begins_with(sk, :prefix)",
            "--expression-attribute-values",
            json.dumps(values),
            "--expression-attribute-names",
            json.dumps(projection),
            "--projection-expression",
            ", ".join(projection),
            "--limit",
            str(MAX_ROBOTS),
            "--no-paginate",
            "--output",
            "json",
        ]


def _display_name(account: _CognitoUser) -> str:
    """Chooses the name the page shows: the e-mail attribute when present, otherwise the username.

    Args:
        account: The user.

    Returns:
        The display name.
    """
    for attribute in account.attributes:
        if attribute.name == "email" and attribute.value:
            return attribute.value
    return account.username


def _scalar(item: dict[str, object], name: str) -> _Scalar | None:
    """Reads one typed attribute of a DynamoDB item, or None when it is absent or of another shape.

    Args:
        item: The item, as the CLI printed it.
        name: The attribute name.

    Returns:
        The typed value, or None.
    """
    raw = item.get(name)
    if raw is None:
        return None
    try:
        return _Scalar.model_validate(raw)
    except ValueError:
        return None


def _text(item: dict[str, object], name: str) -> str | None:
    """Reads a string attribute of a DynamoDB item, or the number as text.

    Args:
        item: The item.
        name: The attribute name.

    Returns:
        The text, or None when absent.
    """
    scalar = _scalar(item, name)
    if scalar is None:
        return None
    return scalar.text if scalar.text is not None else scalar.number


def _robot_row(
    item: dict[str, object], live: dict[str, tuple[str, int]], now_ms: int
) -> RobotRow | None:
    """Builds the row of one registry item, or None when the item lacks a field.

    Args:
        item: The registry item, as projected.
        live: The live states by robot identifier.
        now_ms: The current time, in milliseconds.

    Returns:
        The row, or None for an item that does not match the expected shape.
    """
    robot_id = _text(item, "robotId")
    name = _text(item, "name")
    status = _text(item, "status")
    simulated = _scalar(item, "simulated")
    if (
        robot_id is None
        or ROBOT_ID.fullmatch(robot_id) is None
        or name is None
        or status is None
        or simulated is None
        or simulated.flag is None
    ):
        return None
    kind: RobotKind = "simulated" if simulated.flag else "real"
    state = live.get(robot_id)
    if state is None:
        return RobotRow(robot_id, name, kind, status, "unknown", None)
    state_word, received_ms = state
    stale = now_ms - received_ms > LIVE_STALE_MS
    connection: Connection = "offline" if state_word == "OFFLINE" or stale else "online"
    return RobotRow(robot_id, name, kind, status, connection, _iso_from_ms(received_ms))
