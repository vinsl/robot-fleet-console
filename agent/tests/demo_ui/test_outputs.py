"""Tests of the stack outputs: the grammar of each value, the failures, and the cache."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from fleet_agent.demo_ui.errors import DemoError
from fleet_agent.demo_ui.outputs import StackOutputsSource, parse_outputs
from fleet_agent.demo_ui.runner import CommandResult
from tests.demo_ui.fakes import FakeRunner, fail, ok


def _document(**overrides: str) -> str:
    values = {
        "console_origin": "https://d111aaa.cloudfront.net",
        "user_pool_id": "eu-west-3_AbC123",
        "region": "eu-west-3",
        "fleet_table_name": "mfc-demo-fleet",
    }
    values.update(overrides)
    document: dict[str, object] = {
        name: {"sensitive": False, "type": "string", "value": value}
        for name, value in values.items()
    }
    document["iot_rule_names"] = {"sensitive": False, "type": "list", "value": ["a", "b"]}
    return json.dumps(document)


def test_valid_document_gives_the_four_outputs() -> None:
    outputs = parse_outputs(_document())

    assert outputs.console_origin == "https://d111aaa.cloudfront.net"
    assert outputs.user_pool_id == "eu-west-3_AbC123"
    assert outputs.region == "eu-west-3"
    assert outputs.fleet_table_name == "mfc-demo-fleet"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("console_origin", "http://insecure.example"),
        ("console_origin", "https://evil.example/path"),
        ("user_pool_id", "not a pool"),
        ("region", "eu-west-3; rm -rf"),
        ("fleet_table_name", "other-table"),
    ],
)
def test_malformed_value_is_refused_without_echoing_it(name: str, value: str) -> None:
    with pytest.raises(DemoError) as caught:
        parse_outputs(_document(**{name: value}))

    assert caught.value.code == "STACK_UNAVAILABLE"
    assert value not in caught.value.message


def test_document_that_is_not_json_is_refused() -> None:
    with pytest.raises(DemoError) as caught:
        parse_outputs("not json")

    assert caught.value.code == "STACK_UNAVAILABLE"


def test_missing_output_is_reported_as_not_deployed() -> None:
    document = json.loads(_document())
    del document["fleet_table_name"]

    with pytest.raises(DemoError, match="Deploy the stack first") as caught:
        parse_outputs(json.dumps(document))

    assert caught.value.code == "STACK_UNAVAILABLE"


def _source(
    answer: CommandResult | None, runner: FakeRunner | None = None, tmp: Path | None = None
) -> StackOutputsSource:
    fake = runner or FakeRunner(answer=lambda argv: answer or ok(_document()))
    return StackOutputsSource(fake, tmp or Path("/unused/infra/envs/demo"))


def test_terraform_is_run_read_only_with_the_stack_directory(tmp_path: Path) -> None:
    runner = FakeRunner(answer=lambda argv: ok(_document()))
    source = StackOutputsSource(runner, tmp_path)

    source.get()

    assert runner.calls == [["terraform", f"-chdir={tmp_path}", "output", "-json"]]


def test_successful_read_is_cached_for_the_life_of_the_page(tmp_path: Path) -> None:
    runner = FakeRunner(answer=lambda argv: ok(_document()))
    source = StackOutputsSource(runner, tmp_path)

    source.get()
    source.get()

    assert len(runner.calls) == 1


def test_failed_read_is_retried_on_the_next_call(tmp_path: Path) -> None:
    results: list[CommandResult] = [fail("no state"), ok(_document())]
    runner = FakeRunner(answer=lambda argv: results.pop(0))
    source = StackOutputsSource(runner, tmp_path)

    with pytest.raises(DemoError) as caught:
        source.get()
    assert caught.value.code == "STACK_UNAVAILABLE"
    assert source.get().region == "eu-west-3"


def test_missing_terraform_is_a_clear_stack_error(tmp_path: Path) -> None:
    source = _source(
        CommandResult(returncode=127, stdout="", stderr="command not found", timed_out=False),
        tmp=tmp_path,
    )

    with pytest.raises(DemoError) as caught:
        source.get()

    assert caught.value.code == "STACK_UNAVAILABLE"


def test_expired_session_during_the_read_is_reported_as_no_session(tmp_path: Path) -> None:
    source = _source(fail("ExpiredToken: the token has expired"), tmp=tmp_path)

    with pytest.raises(DemoError) as caught:
        source.get()

    assert caught.value.code == "NO_SESSION"


def test_argv_is_a_list_of_strings(tmp_path: Path) -> None:
    runner = FakeRunner(answer=lambda argv: ok(_document()))

    StackOutputsSource(runner, tmp_path).get()

    seen: Sequence[str] = runner.calls[0]
    assert all(isinstance(part, str) for part in seen)
