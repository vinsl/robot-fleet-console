"""Reads the demo stack outputs with `terraform output -json`, validated and cached.

The outputs give the console origin, the user pool, the region and the fleet table. They are read
with the operator's own session (the state read is covered by the same permission set as `make
publish-console`). The command never locks the state and never changes it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from fleet_agent.demo_ui.errors import DemoError, failure_of
from fleet_agent.demo_ui.runner import CommandRunner

OUTPUT_TIMEOUT_S: Final = 30.0
"""Longest time `terraform output` may take."""

_CONSOLE_ORIGIN: Final = re.compile(r"^https://[a-z0-9.-]{1,253}$")
_USER_POOL_ID: Final = re.compile(r"^[a-z0-9-]+_[A-Za-z0-9]{1,64}$")
_REGION: Final = re.compile(r"^[a-z]{2}(-[a-z]+)+-[0-9]$")
_FLEET_TABLE: Final = re.compile(r"^mfc-demo-[a-z0-9-]{1,200}$")


@dataclass(frozen=True)
class StackOutputs:
    """The demo stack outputs the page uses, each checked against its grammar."""

    console_origin: str
    user_pool_id: str
    region: str
    fleet_table_name: str


class OutputsSource(Protocol):
    """Gives the stack outputs. Implemented by the Terraform reader and by test fakes."""

    def get(self) -> StackOutputs:
        """Returns the outputs.

        Returns:
            The validated outputs.

        Raises:
            DemoError: When the outputs cannot be read or do not match their grammar.
        """
        ...


class _Entry(BaseModel):
    """One Terraform output, as `terraform output -json` writes it. Other fields are ignored."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    value: str


_OUTPUTS: Final = TypeAdapter(dict[str, object])
"""Top level of the JSON document. Its other values (lists, booleans) are not read here."""

_WANTED: Final = ("console_origin", "user_pool_id", "region", "fleet_table_name")


def _checked(name: str, value: str, pattern: re.Pattern[str]) -> str:
    """Checks one output against its grammar.

    Args:
        name: The output name, used in the message.
        value: The value.
        pattern: The grammar.

    Returns:
        The value.

    Raises:
        DemoError: When the value does not match.
    """
    if pattern.fullmatch(value) is None:
        raise DemoError(
            "STACK_UNAVAILABLE", f"The demo stack output {name} has an unexpected format."
        )
    return value


def parse_outputs(document: str) -> StackOutputs:
    """Parses and validates the JSON document of `terraform output -json`.

    Args:
        document: The standard output of the command.

    Returns:
        The validated outputs.

    Raises:
        DemoError: When the document is not JSON, lacks an output, or a value breaks its grammar.
    """
    try:
        top = _OUTPUTS.validate_json(document)
    except ValidationError as error:
        raise DemoError(
            "STACK_UNAVAILABLE", "The demo stack outputs have an unexpected format."
        ) from error
    values: dict[str, str] = {}
    for name in _WANTED:
        entry = top.get(name)
        try:
            values[name] = _Entry.model_validate(entry).value
        except ValidationError as error:
            raise DemoError(
                "STACK_UNAVAILABLE",
                "The demo stack outputs are incomplete. Deploy the stack first.",
            ) from error
    return StackOutputs(
        console_origin=_checked("console_origin", values["console_origin"], _CONSOLE_ORIGIN),
        user_pool_id=_checked("user_pool_id", values["user_pool_id"], _USER_POOL_ID),
        region=_checked("region", values["region"], _REGION),
        fleet_table_name=_checked("fleet_table_name", values["fleet_table_name"], _FLEET_TABLE),
    )


class StackOutputsSource:
    """Reads the outputs once per process after a success; a failure is retried."""

    def __init__(self, runner: CommandRunner, stack_dir: Path) -> None:
        """Creates the source.

        Args:
            runner: Runs `terraform`.
            stack_dir: The directory of the demo Terraform root.
        """
        self._runner = runner
        self._stack_dir = stack_dir
        self._cached: StackOutputs | None = None

    def get(self) -> StackOutputs:
        """Returns the outputs, reading them with `terraform output -json` on the first call.

        Returns:
            The validated outputs.

        Raises:
            DemoError: When terraform fails or the outputs are malformed.
        """
        if self._cached is not None:
            return self._cached
        result = self._runner.run(
            ["terraform", f"-chdir={self._stack_dir}", "output", "-json"],
            timeout_s=OUTPUT_TIMEOUT_S,
        )
        if result.returncode != 0:
            raise failure_of(result, "s3:GetObject", "STACK_UNAVAILABLE")
        self._cached = parse_outputs(result.stdout)
        return self._cached
