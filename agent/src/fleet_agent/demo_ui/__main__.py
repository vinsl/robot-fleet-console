"""Command line of the demo control page.

`python -m fleet_agent.demo_ui [--port N] [--site-id ID]` serves the page on 127.0.0.1 and prints
the start URL, with the token in its fragment, on standard error only. `python -m
fleet_agent.demo_ui links` prints the three console links on standard output and exits.

Exit status: 0 after a clean stop, 1 when a stack output or the links cannot be read, 2 for a
settings error.
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final

from fleet_agent.demo_ui.accounts import AccountWriter
from fleet_agent.demo_ui.aws_reads import AwsReader
from fleet_agent.demo_ui.config import Settings, SettingsError, load_settings
from fleet_agent.demo_ui.demo import DemoController, SystemClock
from fleet_agent.demo_ui.errors import DemoError
from fleet_agent.demo_ui.links import build_links
from fleet_agent.demo_ui.outputs import StackOutputsSource
from fleet_agent.demo_ui.runner import SubprocessRunner, SubprocessSpawner
from fleet_agent.demo_ui.security import new_token
from fleet_agent.demo_ui.server import make_server

EXIT_OK: Final = 0
EXIT_FAILED: Final = 1
EXIT_SETTINGS: Final = 2

LOG_NAME: Final = "demo-ui.log"
"""Private log of the page, in the state directory: step names and codes, never a token."""


def _configure_log(state_dir: Path) -> None:
    """Writes the page's log to a private file, created with mode 600 in a directory of mode 700.

    Args:
        state_dir: The state directory of the page.
    """
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    # The modes are set on every start, not only when the files are created: a directory or log left
    # by an earlier run or another tool must not stay readable by others.
    state_dir.chmod(0o700)
    path = state_dir / LOG_NAME
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
    path.chmod(0o600)
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger = logging.getLogger("fleet_agent.demo_ui")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    # Without this, the root logger's last-resort handler would echo warnings onto the terminal.
    logger.propagate = False


def _controller(settings: Settings) -> tuple[DemoController, StackOutputsSource, AccountWriter]:
    """Wires the controller and the account writer with their real collaborators.

    The controller and the writer share one reader and one clock, so both see the same session.

    Args:
        settings: The validated settings.

    Returns:
        The controller, the outputs source (which the links command also uses) and the writer of
        the operator accounts.
    """
    runner = SubprocessRunner()
    outputs = StackOutputsSource(runner, settings.stack_dir)
    aws = AwsReader(runner, settings, outputs)
    clock = SystemClock()
    controller = DemoController(
        runner=runner,
        spawner=SubprocessSpawner(),
        aws=aws,
        outputs=outputs,
        settings=settings,
        clock=clock,
    )
    accounts = AccountWriter(runner=runner, aws=aws, settings=settings, clock=clock)
    return controller, outputs, accounts


def _print_links(env: Mapping[str, str], argv: Sequence[str]) -> int:
    """Prints the three console links.

    Args:
        env: The environment.
        argv: The arguments after `links`.

    Returns:
        The exit status.
    """
    settings = load_settings(env, argv)
    _, outputs, _ = _controller(settings)
    links = build_links(outputs.get())
    print(f"console:  {links.console_url}")
    print(f"users:    {links.cognito_users_url}")
    print(f"things:   {links.iot_things_url}")
    return EXIT_OK


def _serve(env: Mapping[str, str], argv: Sequence[str]) -> int:
    """Serves the page until interrupted.

    Args:
        env: The environment.
        argv: The command line arguments.

    Returns:
        The exit status.
    """
    settings = load_settings(env, argv)
    _configure_log(settings.state_dir)
    controller, _, accounts = _controller(settings)
    token = new_token()
    server = make_server(settings, controller, token, accounts=accounts)
    # The token is printed once, on standard error, in the fragment: browsers never send a fragment.
    print(
        f"Demo control page: http://127.0.0.1:{server.bound_port}/#token={token}",
        file=sys.stderr,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    """Runs the command line.

    Args:
        argv: The arguments after the program name. Defaults to the process arguments.

    Returns:
        The exit status.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args[:1] == ["links"]:
            return _print_links(os.environ, args[1:])
        return _serve(os.environ, args)
    except SettingsError as failure:
        print(f"demo-ui: {failure}", file=sys.stderr)
        return EXIT_SETTINGS
    except DemoError as failure:
        print(f"demo-ui: {failure.message}", file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
