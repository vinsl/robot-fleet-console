"""Tests of the account writer: the rules, the rate limit, the lock, the script and the logs.

The runner answers every command from a scripted pool: `aws` lists the accounts, `bash` runs the
script. No call reaches AWS, and the clock moves only when a test moves it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic import ValidationError

from fleet_agent.demo_ui.accounts import (
    ACCOUNT_TIMEOUT_S,
    MAX_WRITES,
    WRITE_WINDOW_S,
    AccountBody,
    AccountWriter,
    classify_script_failure,
    parse_script_output,
)
from fleet_agent.demo_ui.aws_reads import AwsReader
from fleet_agent.demo_ui.config import Settings, load_settings
from fleet_agent.demo_ui.errors import DemoError
from fleet_agent.demo_ui.runner import CommandResult
from tests.demo_ui.fakes import STACK, FakeClock, FakeRunner, FixedOutputs, fail, ok

PASSWORD = "Zm9vYmFyYmF6cXV4MTIzNDU2Aa1!"  # noqa: S105 - a fixed test value: 24 base64 chars + suffix
HEADER = "Temporary password for the {role} account, shown once and stored nowhere:"
SIGN_IN = (
    "The user signs in, sets a new password and enrols an authenticator app. "
    "The temporary password expires after one day."
)
EMAIL = "ada@example.test"

Script = Callable[[list[str]], CommandResult]


@dataclass(frozen=True)
class Account:
    """One account of the scripted pool."""

    email: str
    group: str | None
    enabled: bool = True


def _script_stdout(role: str) -> str:
    return f"{HEADER.format(role=role)}\n{PASSWORD}\n{SIGN_IN}\n"


def _runner(accounts: Sequence[Account], script: Script | None = None) -> FakeRunner:
    """Builds a runner that answers the pool and the script, which reads the role it was given."""
    runner = FakeRunner()

    def answer(argv: list[str]) -> CommandResult:
        if argv[0] == "bash":
            if script is not None:
                return script(argv)
            role = (runner.envs[-1] or {})["ROLE"]
            return ok(_script_stdout(role))
        if "list-users-in-group" in argv:
            group = argv[argv.index("--group-name") + 1]
            members = [{"Username": a.email} for a in accounts if a.group == group]
            return ok(json.dumps({"Users": members}))
        if "list-users" in argv:
            users = [
                {
                    "Username": a.email,
                    "Attributes": [{"Name": "email", "Value": a.email}],
                    "Enabled": a.enabled,
                    "UserStatus": "CONFIRMED",
                }
                for a in accounts
            ]
            return ok(json.dumps({"Users": users}))
        return fail("unexpected call")

    runner.answer = answer
    return runner


def _settings(tmp_path: Path) -> Settings:
    return load_settings({"HOME": str(tmp_path)}, [])


def _writer(runner: FakeRunner, settings: Settings, clock: FakeClock) -> AccountWriter:
    aws = AwsReader(runner, settings, FixedOutputs(STACK))
    return AccountWriter(runner=runner, aws=aws, settings=settings, clock=clock)


def _body(email: str = EMAIL, role: str = "Operator", reset: bool = False) -> AccountBody:
    return AccountBody.model_validate({"email": email, "role": role, "reset": reset})


def _script_calls(runner: FakeRunner) -> list[list[str]]:
    return [call for call in runner.calls if call[0] == "bash"]


@pytest.fixture
def propagating_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    # The page's own logger stops propagation once the command line configured its file; the
    # tests need the records to reach caplog.
    monkeypatch.setattr(logging.getLogger("fleet_agent.demo_ui"), "propagate", True)


def test_a_valid_create_returns_the_password_and_runs_the_script_with_the_role(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    runner = _runner([])
    writer = _writer(runner, settings, FakeClock())

    result = writer.write(_body())

    assert result.outcome == "created"
    assert result.role == "Operator"
    assert result.temporary_password == PASSWORD
    assert runner.calls[-1] == ["bash", str(settings.script("bootstrap-admin.sh")), EMAIL]
    assert runner.timeouts[-1] == ACCOUNT_TIMEOUT_S
    env = runner.envs[-1]
    assert env is not None
    assert env["ROLE"] == "Operator"
    assert env["RESET"] == "0"


def test_a_reset_runs_the_script_with_reset_one_and_returns_a_password(tmp_path: Path) -> None:
    runner = _runner([Account(EMAIL, "Viewer")])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    result = writer.write(_body(role="Viewer", reset=True))

    assert result.outcome == "reset"
    assert result.role == "Viewer"
    env = runner.envs[-1]
    assert env is not None
    assert env["ROLE"] == "Viewer"
    assert env["RESET"] == "1"


@pytest.mark.parametrize(
    "email",
    [
        "-ada@example.test",
        'ada"@example.test',
        "ada @example.test",
        "a" * (129 - len("@example.test")) + "@example.test",
        "ada@example",
        "ada@example.test\n",
        "ada@ex\\ample.test",
    ],
    ids=["leading-dash", "quote", "space", "129-chars", "no-tld", "trailing-newline", "backslash"],
)
def test_an_address_outside_the_grammar_is_refused_before_any_call(email: str) -> None:
    with pytest.raises(ValidationError):
        AccountBody.model_validate({"email": email, "role": "Operator"})


def test_an_address_of_128_characters_is_accepted() -> None:
    email = "a" * (128 - len("@example.test")) + "@example.test"

    assert _body(email=email).email == email


@pytest.mark.parametrize("role", ["Admin", "admin", "ADMIN", "none", ""])
def test_admin_and_other_roles_are_never_accepted(role: str) -> None:
    with pytest.raises(ValidationError):
        AccountBody.model_validate({"email": EMAIL, "role": role})


def test_an_extra_field_is_refused() -> None:
    with pytest.raises(ValidationError):
        AccountBody.model_validate({"email": EMAIL, "role": "Operator", "group": "Admin"})


def test_a_non_boolean_reset_is_refused() -> None:
    with pytest.raises(ValidationError):
        AccountBody.model_validate({"email": EMAIL, "role": "Operator", "reset": "1"})


def test_create_on_an_existing_account_is_refused_and_the_script_never_runs(
    tmp_path: Path,
) -> None:
    runner = _runner([Account("ADA@example.test", "Operator")])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(email=EMAIL))

    assert refusal.value.code == "USER_EXISTS"
    assert _script_calls(runner) == []


@pytest.mark.parametrize(
    "account",
    [
        Account(EMAIL, "Admin"),
        Account(EMAIL, None),
        Account(EMAIL, "Operator", enabled=False),
    ],
    ids=["admin", "no-group", "disabled"],
)
def test_reset_of_a_protected_account_is_refused_and_the_script_never_runs(
    tmp_path: Path, account: Account
) -> None:
    runner = _runner([account])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(role="Operator", reset=True))

    assert refusal.value.code == "ACCOUNT_PROTECTED"
    assert _script_calls(runner) == []


def test_reset_with_a_different_role_is_refused(tmp_path: Path) -> None:
    runner = _runner([Account(EMAIL, "Operator")])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(role="Viewer", reset=True))

    assert refusal.value.code == "ROLE_MISMATCH"
    assert _script_calls(runner) == []


def test_reset_of_an_unknown_account_is_refused(tmp_path: Path) -> None:
    runner = _runner([])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(reset=True))

    assert refusal.value.code == "USER_NOT_FOUND"
    assert _script_calls(runner) == []


def test_a_pool_of_200_accounts_or_more_is_refused_because_it_cannot_be_checked(
    tmp_path: Path,
) -> None:
    runner = _runner([Account(f"user{number}@example.test", "Operator") for number in range(200)])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "POOL_TOO_LARGE"
    assert _script_calls(runner) == []


def test_a_failed_account_list_fails_closed_before_the_script(tmp_path: Path) -> None:
    runner = FakeRunner(answer=lambda argv: fail("An error occurred (AccessDeniedException)"))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "PERMISSION_DENIED"
    assert _script_calls(runner) == []


def test_the_sixth_write_in_the_window_is_rate_limited_until_the_window_moves(
    tmp_path: Path,
) -> None:
    clock = FakeClock()
    runner = _runner([])
    writer = _writer(runner, _settings(tmp_path), clock)
    for number in range(MAX_WRITES):
        writer.write(_body(email=f"new{number}@example.test"))
    calls_before = len(runner.calls)

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(email="late@example.test"))

    assert refusal.value.code == "RATE_LIMITED"
    assert len(runner.calls) == calls_before

    clock.current += WRITE_WINDOW_S + 1
    assert writer.write(_body(email="late@example.test")).outcome == "created"


def test_refused_attempts_count_towards_the_rate_limit(tmp_path: Path) -> None:
    clock = FakeClock()
    runner = _runner([Account(EMAIL, "Operator")])
    writer = _writer(runner, _settings(tmp_path), clock)
    for _ in range(MAX_WRITES):
        with pytest.raises(DemoError, match="already exists"):
            writer.write(_body())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(email="other@example.test"))

    assert refusal.value.code == "RATE_LIMITED"


def test_a_second_write_while_one_runs_is_refused_in_progress(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    holder: dict[str, DemoError] = {}

    def nested(argv: list[str]) -> CommandResult:
        if argv[0] == "bash":
            try:
                writer.write(_body(email="second@example.test"))
            except DemoError as refusal:
                holder["second"] = refusal
            return ok(_script_stdout("Operator"))
        return ok(json.dumps({"Users": []}))

    runner = FakeRunner(answer=nested)
    writer = _writer(runner, settings, FakeClock())

    writer.write(_body())

    assert holder["second"].code == "IN_PROGRESS"
    assert holder["second"].message == "Another change is already running."


def test_a_timed_out_script_is_account_timeout(tmp_path: Path) -> None:
    runner = _runner([], script=lambda argv: CommandResult(-1, "", "", True))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "ACCOUNT_TIMEOUT"


@pytest.mark.parametrize(
    ("stderr", "reset", "code"),
    [
        ("bootstrap-admin: no AWS session; run 'aws sso login' first", False, "NO_SESSION"),
        ("bootstrap-admin: ExpiredToken", False, "NO_SESSION"),
        (
            "bootstrap-admin: the user pool id is not in the Terraform outputs; deploy",
            False,
            "STACK_UNAVAILABLE",
        ),
        (
            "bootstrap-admin: the account was created but its group could not be set; rerun",
            False,
            "ACCOUNT_PARTIAL",
        ),
        (
            "bootstrap-admin: the temporary password is set but the sessions could not be "
            "signed out; rerun with RESET=1",
            True,
            "ACCOUNT_PARTIAL",
        ),
        ("An error occurred (AccessDeniedException) when calling", False, "PERMISSION_DENIED"),
        ("An error occurred (InvalidParameterException) when", False, "ACCOUNT_FAILED"),
    ],
    ids=[
        "no-session",
        "expired-token",
        "no-stack",
        "partial-group",
        "partial-sessions",
        "denied",
        "other",
    ],
)
def test_each_script_failure_maps_to_its_code(
    tmp_path: Path, stderr: str, reset: bool, code: str
) -> None:
    runner = FakeRunner(answer=_failing_script(stderr, reset))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(reset=reset))

    assert refusal.value.code == code
    assert stderr not in refusal.value.message


def _failing_script(stderr: str, reset: bool) -> Script:
    """Answers the pool (one Operator for a reset, none for a create) and fails the script."""
    pool = [Account(EMAIL, "Operator")] if reset else []

    def answer(argv: list[str]) -> CommandResult:
        if argv[0] == "bash":
            return fail(stderr)
        if "list-users-in-group" in argv:
            group = argv[argv.index("--group-name") + 1]
            members = [{"Username": a.email} for a in pool if a.group == group]
            return ok(json.dumps({"Users": members}))
        if "list-users" in argv:
            users = [
                {
                    "Username": a.email,
                    "Attributes": [{"Name": "email", "Value": a.email}],
                    "Enabled": a.enabled,
                    "UserStatus": "CONFIRMED",
                }
                for a in pool
            ]
            return ok(json.dumps({"Users": users}))
        return fail("unexpected call")

    return answer


def test_a_script_failure_of_a_reset_names_the_password_action() -> None:
    result = fail("An error occurred (AccessDeniedException) when calling AdminSetUserPassword")

    error = classify_script_failure(result, reset=True)

    assert error.code == "PERMISSION_DENIED"
    assert "cognito-idp:AdminSetUserPassword" in error.message


def test_a_usage_error_of_the_script_is_internal(tmp_path: Path) -> None:
    runner = _runner([], script=lambda argv: fail("usage", returncode=2))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "INTERNAL"


def test_an_empty_success_on_create_is_a_duplicate_and_never_a_second_password(
    tmp_path: Path,
) -> None:
    # The account appeared between the check and the script: it reports it and prints nothing.
    runner = _runner([], script=lambda argv: ok(""))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "USER_EXISTS"


def test_a_reset_with_unexpected_success_output_is_internal(tmp_path: Path) -> None:
    runner = _runner([Account(EMAIL, "Operator")], script=lambda argv: ok("unexpected"))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body(reset=True))

    assert refusal.value.code == "INTERNAL"


def test_an_unexpected_success_output_is_internal_and_never_echoed(tmp_path: Path) -> None:
    hostile = "some unexpected text with a leaked-looking value"
    runner = _runner([], script=lambda argv: ok(hostile))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError) as refusal:
        writer.write(_body())

    assert refusal.value.code == "INTERNAL"
    assert hostile not in refusal.value.message


def test_a_successful_write_logs_one_line_without_the_address_or_the_password(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, propagating_logs: None
) -> None:
    caplog.set_level(logging.INFO, logger="fleet_agent.demo_ui.accounts")
    runner = _runner([])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    result = writer.write(_body())

    records = [r for r in caplog.records if r.name == "fleet_agent.demo_ui.accounts"]
    assert len(records) == 1
    assert records[0].getMessage() == (
        "account write mode=create role=Operator outcome=created rc=0"
    )
    assert PASSWORD not in caplog.text
    assert EMAIL not in caplog.text
    assert PASSWORD not in repr(result)


def test_a_refused_write_logs_its_code_and_no_address(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, propagating_logs: None
) -> None:
    caplog.set_level(logging.INFO, logger="fleet_agent.demo_ui.accounts")
    runner = _runner([Account(EMAIL, "Operator")])
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError):
        writer.write(_body(reset=True, role="Viewer"))

    assert "mode=reset role=Viewer outcome=ROLE_MISMATCH rc=None" in caplog.text
    assert EMAIL not in caplog.text


def test_the_password_in_the_result_is_hidden_from_repr(tmp_path: Path) -> None:
    writer = _writer(_runner([]), _settings(tmp_path), FakeClock())

    answer = writer.write(_body())

    assert answer.temporary_password == PASSWORD
    assert PASSWORD not in repr(answer)


@pytest.mark.parametrize(
    "stdout",
    [
        f"{HEADER.format(role='Operator')}\n{PASSWORD}\n",
        f"{HEADER.format(role='Operator')}\n{PASSWORD}\n{SIGN_IN}\nextra\n",
        f"Some other header\n{PASSWORD}\n{SIGN_IN}\n",
        f"{HEADER.format(role='Viewer')}\n{PASSWORD}\n{SIGN_IN}\n",
        f"{HEADER.format(role='Operator')}\nshort\n{SIGN_IN}\n",
        f"{HEADER.format(role='Operator')}\n{PASSWORD[:-1]}?\n{SIGN_IN}\n",
        f"{HEADER.format(role='Operator')}\n{PASSWORD}x\n{SIGN_IN}\n",
        f"{HEADER.format(role='Operator')}\n{PASSWORD}\nNot the sign in line\n",
        "",
    ],
    ids=[
        "two-lines",
        "four-lines",
        "bad-header",
        "wrong-role-header",
        "short-password",
        "bad-suffix",
        "long-password",
        "bad-sign-in",
        "empty",
    ],
)
def test_the_output_parser_fails_closed(stdout: str) -> None:
    assert parse_script_output(stdout, "Operator") is None


def test_the_output_parser_returns_the_password_of_the_expected_shape() -> None:
    assert parse_script_output(_script_stdout("Viewer"), "Viewer") == PASSWORD


def test_a_failed_pool_read_error_is_never_logged_with_the_address(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, propagating_logs: None
) -> None:
    caplog.set_level(logging.INFO, logger="fleet_agent.demo_ui.accounts")
    runner = FakeRunner(answer=lambda argv: fail("ExpiredToken"))
    writer = _writer(runner, _settings(tmp_path), FakeClock())

    with pytest.raises(DemoError):
        writer.write(_body())

    assert EMAIL not in caplog.text


def test_classify_maps_a_timed_out_run_to_account_timeout() -> None:
    error = classify_script_failure(CommandResult(-1, "", "", True), reset=False)

    assert error.code == "ACCOUNT_TIMEOUT"
