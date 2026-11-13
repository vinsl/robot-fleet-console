"""Tests of the read-only AWS queries: users, groups, robots, live state and errors."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path

import pytest

from fleet_agent.demo_ui.aws_reads import LIVE_STALE_MS, MAX_USERS, AwsReader
from fleet_agent.demo_ui.config import load_settings
from fleet_agent.demo_ui.errors import DemoError
from fleet_agent.demo_ui.runner import CommandResult
from tests.demo_ui.fakes import STACK, FakeRunner, FixedOutputs, fail, ok

NOW_MS = 1_700_000_000_000
ALLOWED_USER_KEYS = {"username_display", "role", "status", "enabled"}
ALLOWED_ROBOT_KEYS = {"robot_id", "name", "kind", "registry_status", "connection", "last_seen"}


def _option(argv: list[str], name: str) -> str | None:
    """Reads the value of an option written as `--name=value`, one argument per option."""
    for part in argv:
        if part.startswith(name + "="):
            return part[len(name) + 1 :]
    return None


class Cloud:
    """Scripted answers of the AWS CLI and of the consumer script, selected by the command."""

    def __init__(self) -> None:
        self.sts: CommandResult = ok("{}")
        self.consumer: CommandResult = ok("Enabled\n")
        self.user_pages: list[dict[str, object]] = [{"Users": []}]
        self.group_pages: dict[str, list[dict[str, object]]] = {}
        self.registry: CommandResult | None = None
        self.registry_items: list[dict[str, object]] = []
        self.live: CommandResult | None = None
        self.live_items: list[dict[str, object]] = []

    def answer(self, argv: list[str]) -> CommandResult:
        if argv[:3] == ["aws", "sts", "get-caller-identity"]:
            return self.sts
        if argv[0] == "terraform":
            return ok(
                json.dumps(
                    {
                        "console_origin": {"value": STACK.console_origin},
                        "user_pool_id": {"value": STACK.user_pool_id},
                        "region": {"value": STACK.region},
                        "fleet_table_name": {"value": STACK.fleet_table_name},
                    }
                )
            )
        if argv[0] == "bash":
            return self.consumer
        if "list-users" in argv:
            token = _option(argv, "--pagination-token") or "0"
            return ok(json.dumps(self.user_pages[int(token)]))
        if "list-users-in-group" in argv:
            group = argv[argv.index("--group-name") + 1]
            token = _option(argv, "--next-token") or "0"
            pages = self.group_pages.get(group, [{"Users": []}])
            return ok(json.dumps(pages[int(token)]))
        if "dynamodb" in argv:
            if "STATE#" in " ".join(argv):
                if self.live is not None:
                    return self.live
                return ok(json.dumps({"Items": self.live_items}))
            if self.registry is not None:
                return self.registry
            return ok(json.dumps({"Items": self.registry_items}))
        return fail("unexpected command")


def _reader(cloud: Cloud, tmp_path: Path) -> tuple[AwsReader, FakeRunner]:
    runner = FakeRunner(answer=cloud.answer)
    settings = load_settings({"HOME": str(tmp_path)}, [])
    reader = AwsReader(runner, settings, FixedOutputs(STACK), clock_ms=lambda: NOW_MS)
    return reader, runner


def _user(
    name: str, email: str | None = None, enabled: bool = True, status: str = "CONFIRMED"
) -> dict[str, object]:
    attributes = [] if email is None else [{"Name": "email", "Value": email}]
    return {"Username": name, "Attributes": attributes, "Enabled": enabled, "UserStatus": status}


def _robot(robot_id: str, simulated: bool, status: str = "ACTIVE") -> dict[str, object]:
    return {
        "robotId": {"S": robot_id},
        "name": {"S": robot_id.upper()},
        "simulated": {"BOOL": simulated},
        "status": {"S": status},
    }


def _live(robot_id: str, state: str, received_ms: int = NOW_MS) -> dict[str, object]:
    return {
        "robotId": {"S": robot_id},
        "state": {"S": state},
        "receivedAt": {"N": str(received_ms)},
    }


def test_session_is_valid_only_when_the_caller_identity_call_succeeds(tmp_path: Path) -> None:
    cloud = Cloud()
    reader, _ = _reader(cloud, tmp_path)

    assert reader.session_identity().valid is True
    cloud.sts = fail("ExpiredToken")
    assert reader.session_identity().valid is False


def test_consumer_state_is_the_script_word_or_unknown(tmp_path: Path) -> None:
    cloud = Cloud()
    reader, _ = _reader(cloud, tmp_path)

    assert reader.consumer_state() == "Enabled"
    cloud.consumer = ok("<html>surprise</html>")
    assert reader.consumer_state() == "unknown"
    cloud.consumer = fail()
    assert reader.consumer_state() == "unknown"


def test_users_get_the_highest_role_of_their_groups(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = [
        {
            "Users": [
                _user("u-admin", "ada@example.test"),
                _user("u-op"),
                _user("u-none", enabled=False, status="FORCE_CHANGE_PASSWORD"),
            ]
        }
    ]
    cloud.group_pages = {
        "Admin": [{"Users": [{"Username": "u-admin"}]}],
        "Operator": [{"Users": [{"Username": "u-op"}, {"Username": "u-admin"}]}],
    }
    reader, _ = _reader(cloud, tmp_path)

    rows = {row.username_display: row for row in reader.list_users()}

    assert rows["ada@example.test"].role == "Admin"
    assert rows["u-op"].role == "Operator"
    assert rows["u-none"].role == "none"
    assert rows["u-none"].enabled is False
    assert rows["u-none"].status == "FORCE_CHANGE_PASSWORD"


def test_users_follow_the_pagination_token(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = [
        {"Users": [_user("first")], "PaginationToken": "1"},
        {"Users": [_user("second")]},
    ]
    reader, runner = _reader(cloud, tmp_path)

    names = [row.username_display for row in reader.list_users()]

    assert names == ["first", "second"]
    second_call = runner.calls[1]
    assert "--pagination-token=1" in second_call


def test_user_list_is_capped_at_two_hundred(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = [
        {
            "Users": [_user(f"u{page}-{index}") for index in range(60)],
            "PaginationToken": str(page + 1),
        }
        for page in range(4)
    ]
    reader, _ = _reader(cloud, tmp_path)

    assert len(reader.list_users()) == MAX_USERS == 200


def test_group_membership_follows_next_token(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = [{"Users": [_user("far")]}]
    cloud.group_pages = {
        "Viewer": [{"Users": [], "NextToken": "1"}, {"Users": [{"Username": "far"}]}]
    }
    reader, _ = _reader(cloud, tmp_path)

    assert reader.list_users()[0].role == "Viewer"


def test_user_read_without_permission_names_the_action_only(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = []  # never reached: the first call is refused below
    reader, runner = _reader(cloud, tmp_path)
    denied = fail(
        "An error occurred (AccessDenied) when calling the ListUsers operation: "
        "User: arn:aws:sts::123456789012:assumed-role/x"
    )
    original = runner.answer
    runner.answer = lambda argv: denied if "list-users" in argv else original(argv)

    with pytest.raises(DemoError) as caught:
        reader.list_users()

    assert caught.value.code == "PERMISSION_DENIED"
    assert "cognito-idp:ListUsers" in caught.value.message
    assert "123456789012" not in caught.value.message


def test_expired_session_during_a_read_is_no_session(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.registry = fail("ExpiredToken: The security token included in the request is expired")
    reader, _ = _reader(cloud, tmp_path)

    with pytest.raises(DemoError) as caught:
        reader.list_robots("paris-01")

    assert caught.value.code == "NO_SESSION"


def test_robots_are_simulated_or_real_and_leave_out_retired_entries(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.registry_items = [
        _robot("sim-01", True),
        _robot("kali-01", False),
        _robot("old-01", False, "RETIRED"),
    ]
    reader, _ = _reader(cloud, tmp_path)

    rows = {row.robot_id: row for row in reader.list_robots("paris-01")}

    assert rows["sim-01"].kind == "simulated"
    assert rows["kali-01"].kind == "real"
    assert "old-01" not in rows
    assert list(rows) == ["kali-01", "sim-01"]


def test_connection_is_unknown_without_live_data(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.registry_items = [_robot("sim-01", True)]
    reader, _ = _reader(cloud, tmp_path)

    row = reader.list_robots("paris-01")[0]

    assert row.connection == "unknown"
    assert row.last_seen is None


def test_connection_is_online_for_fresh_state_and_offline_for_offline_or_stale(
    tmp_path: Path,
) -> None:
    cloud = Cloud()
    cloud.registry_items = [_robot("sim-01", True), _robot("sim-02", True), _robot("sim-03", True)]
    cloud.live_items = [
        _live("sim-01", "IDLE"),
        _live("sim-02", "OFFLINE"),
        _live("sim-03", "MOVING", NOW_MS - LIVE_STALE_MS - 1),
    ]
    reader, _ = _reader(cloud, tmp_path)

    rows = {row.robot_id: row for row in reader.list_robots("paris-01")}

    assert rows["sim-01"].connection == "online"
    assert rows["sim-01"].last_seen == "2023-11-14T22:13:20Z"
    assert rows["sim-02"].connection == "offline"
    assert rows["sim-03"].connection == "offline"


def test_live_state_failure_other_than_permission_leaves_connections_unknown(
    tmp_path: Path,
) -> None:
    cloud = Cloud()
    cloud.registry_items = [_robot("sim-01", True)]
    cloud.live = fail("ServiceUnavailable")
    reader, _ = _reader(cloud, tmp_path)

    assert reader.list_robots("paris-01")[0].connection == "unknown"


def test_live_state_permission_failure_is_an_error(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.registry_items = [_robot("sim-01", True)]
    cloud.live = fail("AccessDeniedException: not authorized to perform dynamodb:Query")
    reader, _ = _reader(cloud, tmp_path)

    with pytest.raises(DemoError) as caught:
        reader.list_robots("paris-01")

    assert caught.value.code == "PERMISSION_DENIED"


def test_items_without_the_expected_shape_are_left_out(tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.registry_items = [
        _robot("sim-01", True),
        {
            "robotId": {"S": "Bad Id"},
            "name": {"S": "x"},
            "simulated": {"BOOL": True},
            "status": {"S": "ACTIVE"},
        },
        {"robotId": {"S": "sim-09"}},
    ]
    reader, _ = _reader(cloud, tmp_path)

    assert [row.robot_id for row in reader.list_robots("paris-01")] == ["sim-01"]


def test_query_is_one_page_and_takes_its_values_as_attributes(tmp_path: Path) -> None:
    cloud = Cloud()
    reader, runner = _reader(cloud, tmp_path)

    reader.list_robots("paris-01")

    registry_call = runner.calls[0]
    assert "--no-paginate" in registry_call
    values = json.loads(registry_call[registry_call.index("--expression-attribute-values") + 1])
    assert values == {":pk": {"S": "SITE#paris-01"}, ":prefix": {"S": "ROBOT#"}}


def test_site_outside_its_grammar_is_refused_before_any_call(tmp_path: Path) -> None:
    cloud = Cloud()
    reader, runner = _reader(cloud, tmp_path)

    with pytest.raises(ValueError, match="grammar"):
        reader.list_robots("../x")
    assert runner.calls == []


def test_kept_rows_hold_no_secret_even_when_the_answers_carry_one(tmp_path: Path) -> None:
    secret_user = _user("u1", "ada@example.test")
    secret_user.update(
        {
            "TemporaryPassword": "hunter2-temp",
            "Arn": "arn:aws:cognito-idp:eu-west-3:123456789012:userpool/x",
        }
    )
    secret_robot = _robot("sim-01", True)
    secret_robot.update(
        {
            "Arn": "arn:aws:iot:eu-west-3:123456789012:thing/sim-01",
            "accountId": {"S": "123456789012"},
        }
    )
    cloud = Cloud()
    cloud.user_pages = [{"Users": [secret_user]}]
    cloud.registry_items = [secret_robot]
    reader, _ = _reader(cloud, tmp_path)

    users = reader.list_users()
    robots = reader.list_robots("paris-01")

    for row in users:
        assert set(asdict(row)) == ALLOWED_USER_KEYS
    for robot in robots:
        assert set(asdict(robot)) == ALLOWED_ROBOT_KEYS
    dumped = json.dumps([asdict(row) for row in users] + [asdict(robot) for robot in robots])
    for forbidden in (
        "hunter2",
        "arn:aws",
        "123456789012",
        "Password",
        "password",
        "token",
        "privateKey",
    ):
        assert forbidden not in dumped


@pytest.mark.parametrize("argv_part", ["--pagination-token", "--next-token"])
def test_every_list_call_is_bounded_by_the_page_size(argv_part: str, tmp_path: Path) -> None:
    cloud = Cloud()
    cloud.user_pages = [{"Users": [_user("a")], "PaginationToken": "1"}, {"Users": [_user("b")]}]
    cloud.group_pages = {"Admin": [{"Users": [], "NextToken": "1"}, {"Users": []}]}
    reader, runner = _reader(cloud, tmp_path)

    reader.list_users()

    listed: Sequence[list[str]] = [
        call for call in runner.calls if "list-users" in call or "list-users-in-group" in call
    ]
    assert listed
    for call in listed:
        assert call[call.index("--limit") + 1] == "60"


def test_pagination_token_travels_as_one_argument_even_when_it_looks_like_an_option(
    tmp_path: Path,
) -> None:
    settings = load_settings({"HOME": str(tmp_path)}, [])
    option_value = "--region=us-east-1"  # a value that looks like an option, not a secret

    def answer(argv: list[str]) -> CommandResult:
        if any(part.startswith("--pagination-token=") for part in argv):
            return ok(json.dumps({"Users": []}))
        return ok(json.dumps({"Users": [], "PaginationToken": option_value}))

    runner = FakeRunner(answer=answer)
    AwsReader(runner, settings, FixedOutputs(STACK), clock_ms=lambda: NOW_MS).list_users()

    second = next(
        call for call in runner.calls if any(p.startswith("--pagination-token=") for p in call)
    )
    assert f"--pagination-token={option_value}" in second
    assert option_value not in second
