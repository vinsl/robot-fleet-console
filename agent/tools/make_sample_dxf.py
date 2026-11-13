"""Generate the sample warehouse DXF used to exercise the site configuration import.

The drawing is original work of the author, all rights reserved, with no reuse licence granted (see
``sample/README.md``). It is deterministic: the same script always writes the same bytes, which lets
a test fail when the committed sample drifts from the generator.

Run from ``agent/`` with ``uv run python tools/make_sample_dxf.py``.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

# ezdxf does not re-export its options module from the package, so mypy --strict reports the name
# as missing. The module exists and the import works at run time.
from ezdxf import options as ezdxf_options  # type: ignore[attr-defined]
from ezdxf.document import Drawing
from ezdxf.filemanagement import new as new_drawing
from ezdxf.units import MM

DEFAULT_OUT = Path(__file__).resolve().parent / "sample" / "warehouse.dxf"
"""Where the committed sample lives, resolved from this file so the script works from any cwd."""

_DXF_VERSION = "R2010"
_LAYERS = ("WALLS", "RACKS", "MACHINES", "DIMENSIONS", "NOTES")
_RACK_BLOCK = "RACK"
_RACK_ORIGINS: tuple[tuple[float, float], ...] = tuple(
    (x, y) for y in (4000.0, 17000.0, 30000.0) for x in (40000.0, 44000.0, 48000.0, 52000.0)
)
"""Twelve rack positions in millimetres: three rows of four, clear of the door and the walls."""


def build_sample() -> Drawing:
    """Builds the warehouse drawing in millimetres, 60 m by 40 m.

    The layout exercises every import path: closed and open walls, an arc, a block inserted many
    times whose entities inherit the insert layer, closed machine outlines, circles, and the
    annotation entities that the importer must count as ignored.

    Returns:
        An in-memory R2010 drawing. Nothing in it depends on the clock or on randomness.
    """
    with _fixed_metadata():
        doc = new_drawing(dxfversion=_DXF_VERSION, setup=False)
    doc.units = MM
    for name in _LAYERS:
        doc.layers.add(name)

    rack = doc.blocks.new(name=_RACK_BLOCK)
    # Layer "0" on purpose: the importer must give the block entity the layer of each INSERT.
    rack.add_lwpolyline([(0, 0), (3000, 0), (3000, 1000), (0, 1000)], close=True)

    msp = doc.modelspace()

    msp.add_lwpolyline(
        [(0, 0), (60000, 0), (60000, 40000), (0, 40000)],
        close=True,
        dxfattribs={"layer": "WALLS"},
    )
    msp.add_line((30000, 0), (30000, 12000), dxfattribs={"layer": "WALLS"})
    msp.add_line((30000, 20000), (30000, 40000), dxfattribs={"layer": "WALLS"})
    msp.add_arc(
        center=(30000, 12000),
        radius=8000,
        start_angle=0,
        end_angle=90,
        dxfattribs={"layer": "WALLS"},
    )

    for x, y in _RACK_ORIGINS:
        msp.add_blockref(_RACK_BLOCK, (x, y), dxfattribs={"layer": "RACKS"})

    msp.add_lwpolyline(
        [(5000, 5000), (9000, 5000), (9000, 8000), (5000, 8000)],
        close=True,
        dxfattribs={"layer": "MACHINES"},
    )
    msp.add_lwpolyline(
        [(5000, 20000), (9000, 20000), (10000, 23000), (7000, 25000), (4000, 23000)],
        close=True,
        dxfattribs={"layer": "MACHINES"},
    )
    msp.add_circle(center=(15000, 10000), radius=300, dxfattribs={"layer": "MACHINES"})
    msp.add_circle(center=(15000, 30000), radius=300, dxfattribs={"layer": "MACHINES"})

    msp.add_line((0, -2000), (60000, -2000), dxfattribs={"layer": "DIMENSIONS"})
    msp.add_line((0, -500), (0, -2500), dxfattribs={"layer": "DIMENSIONS"})
    msp.add_line((60000, -500), (60000, -2500), dxfattribs={"layer": "DIMENSIONS"})
    msp.add_text(
        "60 m",
        dxfattribs={"height": 1200, "layer": "DIMENSIONS", "insert": (28000, -3000)},
    )

    note = msp.add_mtext(
        "Sample warehouse for Fleet Console, 60 m by 40 m.",
        dxfattribs={"layer": "NOTES", "char_height": 1000},
    )
    note.set_location((0, 44000))

    return doc


@contextmanager
def _fixed_metadata() -> Iterator[None]:
    """Makes ezdxf write fixed save times and GUIDs while the block runs.

    ezdxf stamps the creation time, the save time, a random fingerprint and an ezdxf version marker
    with the current clock. The option is an in-memory switch: it is turned on only for the
    drawing's creation and save and restored afterwards, and nothing is written to the user's
    configuration. The switch is a global ezdxf option, so this helper is for CLI use only and must
    not be used to save other drawings.

    Yields:
        Nothing; the caller runs its ezdxf calls inside the block.
    """
    previous = ezdxf_options.write_fixed_meta_data_for_testing
    ezdxf_options.write_fixed_meta_data_for_testing = True
    try:
        yield
    finally:
        ezdxf_options.write_fixed_meta_data_for_testing = previous


def write_sample(doc: Drawing, path: Path) -> None:
    """Saves the drawing to ``path`` with the fixed metadata of :func:`_fixed_metadata`.

    Args:
        doc: The drawing to save.
        path: The destination file; its parent directory must exist.
    """
    doc.commit_pending_changes()
    _register_in_use_classes_in_order(doc)
    with _fixed_metadata():
        doc.saveas(str(path))


def _register_in_use_classes_in_order(doc: Drawing) -> None:
    """Registers the DXF classes of the entity types in use, in sorted order, before the save.

    ezdxf adds these classes while it writes, iterating a set of type names. Python randomises
    string hashes for each process, so the CLASSES section, and with it the file, came out in a
    different order from run to run. Registering the same classes here, sorted, leaves ezdxf
    nothing to add in its own order.

    Args:
        doc: The drawing about to be saved, with its pending changes committed.
    """
    for name in sorted(doc.entitydb.dxf_types_in_use()):
        doc.classes.add_class(name)


def main(argv: Sequence[str] | None = None) -> int:
    """Writes the sample drawing to a file and prints its path.

    Args:
        argv: Command-line arguments without the program name; ``None`` reads ``sys.argv``.

    Returns:
        The process exit code, 0 on success.
    """
    parser = argparse.ArgumentParser(description="Generate the sample warehouse DXF.")
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output file (default: tools/sample/warehouse.dxf next to this script).",
    )
    args = parser.parse_args(argv)

    doc = build_sample()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_sample(doc, args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
