"""Runs the coroutine tests of the video package on a fresh event loop.

The agent has no async test plugin: its existing async tests call `asyncio.run` themselves. This
hook gives the video tests the same behaviour without a new dependency, so each test owns a loop
that is closed when the test ends.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: pytest.Function) -> bool | None:
    """Runs an `async def` test to completion on its own event loop.

    Args:
        pyfuncitem: The test item about to be called.

    Returns:
        True when the coroutine was run here, None to let pytest call a plain test.
    """
    function = pyfuncitem.obj
    if not inspect.iscoroutinefunction(function):
        return None
    names = inspect.signature(function).parameters
    kwargs = {name: pyfuncitem.funcargs[name] for name in names}
    asyncio.run(function(**kwargs))
    return True
