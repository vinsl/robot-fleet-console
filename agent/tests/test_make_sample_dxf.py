"""Tests for the sample warehouse DXF generator and the committed sample it produces."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol, cast

import ezdxf
import pytest
from ezdxf.document import Drawing

TOOL_PATH = Path(__file__).resolve().parents[1] / "tools" / "make_sample_dxf.py"
COMMITTED_SAMPLE = Path(__file__).resolve().parents[1] / "tools" / "sample" / "warehouse.dxf"
EXPECTED_LAYERS = {"WALLS", "RACKS", "MACHINES", "DIMENSIONS", "NOTES"}
MM_UNITS = 4


class SampleTool(Protocol):
    """The public surface of ``tools/make_sample_dxf.py`` as the tests use it."""

    DEFAULT_OUT: Path

    def build_sample(self) -> Drawing:
        """Builds the drawing in memory."""
        ...

    def main(self, argv: Sequence[str] | None = None) -> int:
        """Runs the command-line entry point."""
        ...


def _load_tool() -> SampleTool:
    """Loads the script by path, because ``tools/`` is not an importable package.

    Returns:
        The loaded module, typed as the protocol the tests rely on.
    """
    spec = importlib.util.spec_from_file_location("make_sample_dxf", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast(SampleTool, module)


def test_build_sample_is_in_millimetres_with_the_expected_layers() -> None:
    doc = _load_tool().build_sample()

    assert doc.header["$INSUNITS"] == MM_UNITS
    assert {layer.dxf.name for layer in doc.layers} >= EXPECTED_LAYERS


def test_twelve_rack_inserts_reference_the_rack_block() -> None:
    doc = _load_tool().build_sample()

    inserts = [e for e in doc.modelspace().query("INSERT") if e.dxf.name == "RACK"]
    assert len(inserts) == 12
    assert "RACK" in doc.blocks
    assert {e.dxf.layer for e in inserts} == {"RACKS"}


def test_walls_span_sixty_by_forty_metres() -> None:
    doc = _load_tool().build_sample()

    outer = [
        e for e in doc.modelspace().query("LWPOLYLINE") if e.dxf.layer == "WALLS" and e.is_closed
    ]
    assert len(outer) == 1
    xs = [p[0] for p in outer[0].get_points("xy")]
    ys = [p[1] for p in outer[0].get_points("xy")]
    assert (min(xs), max(xs), min(ys), max(ys)) == (0, 60000, 0, 40000)


def test_annotations_are_present_for_the_ignored_entity_report() -> None:
    doc = _load_tool().build_sample()

    types = {e.dxftype() for e in doc.modelspace()}
    assert {"TEXT", "MTEXT"} <= types


def test_cli_writes_the_file_and_prints_its_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    tool = _load_tool()
    out = tmp_path / "nested" / "sample.dxf"

    assert tool.main(["--out", str(out)]) == 0

    assert out.is_file()
    assert ezdxf.readfile(str(out)).header["$INSUNITS"] == MM_UNITS
    printed = capsys.readouterr().out
    assert printed.strip() == str(out)


def test_generator_output_matches_the_committed_sample_byte_for_byte(tmp_path: Path) -> None:
    tool = _load_tool()
    out = tmp_path / "regenerated.dxf"
    assert tool.main(["--out", str(out)]) == 0

    assert out.read_bytes() == COMMITTED_SAMPLE.read_bytes()


HASH_SEEDS = tuple(str(seed) for seed in range(8))
"""Python hash seeds the regression test runs the generator under, one process each."""


def test_output_does_not_depend_on_the_hash_seed(tmp_path: Path) -> None:
    """Regression test: the file used to change with the per-process string hash seed.

    Seeds 0 and 4 wrote different files before the DXF classes were registered in a fixed order.
    Every seed in ``HASH_SEEDS`` must write the same bytes as the first one.
    """
    outputs: dict[str, bytes] = {}
    for seed in HASH_SEEDS:
        out = tmp_path / f"seed-{seed}.dxf"
        # S603: the interpreter and script are fixed repository paths, no untrusted input
        subprocess.run(  # noqa: S603
            [sys.executable, str(TOOL_PATH), "--out", str(out)],
            env={**os.environ, "PYTHONHASHSEED": seed},
            check=True,
            capture_output=True,
        )
        outputs[seed] = out.read_bytes()

    reference = outputs[HASH_SEEDS[0]]
    differing = [seed for seed, data in outputs.items() if data != reference]
    assert differing == [], f"output differs from seed {HASH_SEEDS[0]} for seeds {differing}"


def test_default_output_is_the_committed_sample() -> None:
    assert _load_tool().DEFAULT_OUT.samefile(COMMITTED_SAMPLE)
