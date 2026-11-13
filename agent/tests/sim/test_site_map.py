"""Tests of the simulator's site map: parity with the protocol fixtures,
and the simulator's limits."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from fleet_agent.core.model import Point
from fleet_agent.sim import site_map
from fleet_agent.sim.grid import build_grid
from fleet_agent.sim.site_map import SiteMapError, load_site_map, parse_site_map
from tests.sim.support import (
    INVALID_MAP_DIR,
    SAMPLE_MAP_PATH,
    sample_document,
    write_map,
)

_INVALID_FIXTURES = sorted(INVALID_MAP_DIR.glob("*.geojson"))

SIZED_MAP_PATH = SAMPLE_MAP_PATH.with_name("workstation-with-size.geojson")
"""The protocol's sample with a footprint on two workstations, read by the console tests too."""


def test_the_sample_map_parses_into_its_charger_stations_and_bounds() -> None:
    """Given the protocol's sample, when loaded, then the charger,
    the four stations and the bounds match."""
    loaded = load_site_map(SAMPLE_MAP_PATH)

    assert loaded.charger == Point(3.0, 3.0)
    assert [station.name for station in loaded.stations] == ["dock-a", "dock-b", "pack-c", "pack-d"]
    assert loaded.stations[0].point == Point(8.0, 36.0)
    assert loaded.bounds == (0.0, 0.0, 60.0, 40.0)
    assert len(loaded.walls) == 1
    assert len(loaded.obstacles) == 3
    assert len(loaded.nogos) == 1


@pytest.mark.parametrize("fixture", _INVALID_FIXTURES, ids=lambda path: path.name)
def test_each_invalid_protocol_fixture_is_refused(fixture: Path) -> None:
    """Given an invalid fixture of the protocol, when loaded, then the simulator refuses it too."""
    with pytest.raises(SiteMapError):
        load_site_map(fixture)


def test_point_only_workstations_have_no_footprint() -> None:
    """Given a version 1 map with point-only workstations, when loaded, then none has a size."""
    loaded = load_site_map(SAMPLE_MAP_PATH)

    assert [station.size for station in loaded.stations] == [None, None, None, None]


def test_a_footprint_is_kept_and_the_point_stays_the_mission_target() -> None:
    """Given a bay with a footprint, when loaded, then its size is kept, its point stays."""
    loaded = load_site_map(SIZED_MAP_PATH)
    by_name = {station.name: station for station in loaded.stations}

    assert by_name["dock-a"].size == (2.0, 3.0)
    assert by_name["dock-a"].point == Point(8.0, 36.0)
    assert by_name["pack-d"].size == (1.5, 1.5)
    assert by_name["dock-b"].size is None


def test_a_footprint_does_not_change_the_grid_the_planner_reads() -> None:
    """Given the sample with and without footprints, when grids are built, then they match."""
    plain = build_grid(load_site_map(SAMPLE_MAP_PATH))
    sized = build_grid(load_site_map(SIZED_MAP_PATH))

    assert (sized.width, sized.height, sized.origin_x, sized.origin_y) == (
        plain.width,
        plain.height,
        plain.origin_x,
        plain.origin_y,
    )
    assert sized.blocked == plain.blocked


def test_a_footprint_that_pushes_the_extent_over_the_limit_is_refused() -> None:
    """Given a bay whose centre is in range but whose footprint is not, the extent refuses it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    bay: dict[str, object] = {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [180, 5]},
        "properties": {"kind": "workstation", "name": "far-bay"},
    }
    features.append(bay)
    # The centre alone is 180 m from the origin, inside the 200 m limit: the control passes.
    assert parse_site_map(_as_bytes(document)).bounds[2] == 180

    # A 40 m footprint reaches exactly 200 m, which is still inside the limit.
    bay["properties"] = {
        "kind": "workstation",
        "name": "far-bay",
        "size": {"width": 40, "height": 2},
    }
    assert parse_site_map(_as_bytes(document)).bounds[2] == 200

    # A 50 m footprint reaches 205 m: refused although the centre is in range.
    bay["properties"] = {
        "kind": "workstation",
        "name": "far-bay",
        "size": {"width": 50, "height": 2},
    }
    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == "EXTENT"


def test_a_footprint_side_outside_the_bounds_is_refused_by_the_schema() -> None:
    """Given a footprint of 0.05 m, when parsed, then the schema refuses it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    workstation = next(f for f in features if _kind(f) == "workstation")
    assert isinstance(workstation, dict)
    properties = workstation["properties"]
    assert isinstance(properties, dict)
    properties["size"] = {"width": 0.05, "height": 2}

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == "SCHEMA"


def test_a_symbolic_link_is_refused_even_when_it_points_at_a_valid_map(tmp_path: Path) -> None:
    """Given a link to a valid map, when loaded, then it is refused before anything is read."""
    link = tmp_path / "link.geojson"
    link.symlink_to(SAMPLE_MAP_PATH)

    with pytest.raises(SiteMapError) as refused:
        load_site_map(link)

    assert refused.value.code == "SYMLINK"


def test_a_missing_file_is_reported_as_unreadable(tmp_path: Path) -> None:
    """Given no file, when loaded, then it is refused as unreadable, not as a crash."""
    with pytest.raises(SiteMapError) as refused:
        load_site_map(tmp_path / "absent.geojson")

    assert refused.value.code == "UNREADABLE"


def test_a_directory_is_refused_as_not_a_regular_file(tmp_path: Path) -> None:
    """Given a directory, when loaded, then it is refused as not a regular file."""
    with pytest.raises(SiteMapError) as refused:
        load_site_map(tmp_path)

    assert refused.value.code == "NOT_A_FILE"


def test_a_file_larger_than_the_limit_is_refused_before_it_is_read(tmp_path: Path) -> None:
    """Given a file over two megabytes, when loaded, then it is refused by its size."""
    big = tmp_path / "big.geojson"
    big.write_bytes(b" " * (site_map.SITE_MAP_MAX_BYTES + 1))

    with pytest.raises(SiteMapError) as refused:
        load_site_map(big)

    assert refused.value.code == "TOO_LARGE"


def test_text_over_the_limit_is_refused_by_the_parser_too() -> None:
    """Given bytes over the limit, when parsed, then the parser refuses them by size."""
    with pytest.raises(SiteMapError) as refused:
        parse_site_map(b" " * (site_map.SITE_MAP_MAX_BYTES + 1))

    assert refused.value.code == "TOO_LARGE"


def test_text_that_is_not_json_is_refused_as_not_json() -> None:
    """Given text that is not JSON, when parsed, then it is refused without echoing the text."""
    with pytest.raises(SiteMapError) as refused:
        parse_site_map(b"{not json")

    assert refused.value.code == "NOT_JSON"
    assert "not json" not in str(refused.value)


def test_a_number_too_large_for_a_float_is_refused_by_its_bounds() -> None:
    """Given a coordinate that overflows to infinity, when parsed, then the bounds refuse it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    wall = features[0]
    assert isinstance(wall, dict)
    wall["geometry"] = {"type": "LineString", "coordinates": [[0, 0], [float("inf"), 0]]}
    # json.dumps writes infinity as a bare word, which is not JSON; a file holds the literal 1e999.
    text = _as_bytes(document).replace(b"Infinity", b"1e999")

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(text)

    assert refused.value.code == "SCHEMA"
    assert refused.value.detail is not None


def test_a_schema_refusal_names_the_field_and_no_value(tmp_path: Path) -> None:
    """Given a wrong value, when loaded, then the refusal names the field path and not the value."""
    document = sample_document()
    fleet = document["fleet"]
    assert isinstance(fleet, dict)
    fleet["crs"] = "EPSG:4326-SECRET-VALUE"
    path = write_map(tmp_path / "wrong.geojson", document)

    with pytest.raises(SiteMapError) as refused:
        load_site_map(path)

    assert refused.value.code == "SCHEMA"
    assert refused.value.detail == "fleet.crs"
    assert "SECRET-VALUE" not in str(refused.value)


def test_a_map_wider_than_the_simulator_limit_is_refused() -> None:
    """Given a map 250 m across, when parsed,
    then the simulator refuses it although the protocol allows it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    features.append(
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [250, 0]},
            "properties": {"kind": "workstation", "name": "far-away"},
        }
    )

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == "EXTENT"


def test_a_map_with_too_many_positions_is_refused() -> None:
    """Given more positions than the protocol allows, when parsed,
    then the vertex count refuses it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    wall = copy.deepcopy(features[0])
    assert isinstance(wall, dict)
    wall["geometry"] = {"type": "LineString", "coordinates": [[0, 0]] * 50_001}
    features[0] = wall

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == "VERTEX_COUNT"


@pytest.mark.parametrize(
    ("code", "edit"),
    [
        ("CHARGER_COUNT", "drop_charger"),
        ("WORKSTATION_COUNT", "drop_one_workstation"),
        ("WORKSTATION_NAMES", "rename_workstation"),
    ],
)
def test_the_cross_feature_rules_are_checked_after_the_structure(code: str, edit: str) -> None:
    """Given a map that breaks one cross-feature rule, when parsed,
    then that rule names the refusal."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    if edit == "drop_charger":
        features[:] = [f for f in features if _kind(f) != "charger"]
    elif edit == "drop_one_workstation":
        workstations = [f for f in features if _kind(f) == "workstation"]
        features[:] = [f for f in features if _kind(f) != "workstation" or f is workstations[0]]
    else:
        names = [f for f in features if _kind(f) == "workstation"]
        assert isinstance(names[1], dict)
        names[1]["properties"] = {"kind": "workstation", "name": "dock-a"}

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == code


def test_an_open_ring_is_refused_by_the_schema() -> None:
    """Given an obstacle whose ring is not closed, when parsed, then the schema refuses it."""
    document = sample_document()
    features = document["features"]
    assert isinstance(features, list)
    obstacle = next(f for f in features if _kind(f) == "obstacle")
    assert isinstance(obstacle, dict)
    geometry = obstacle["geometry"]
    assert isinstance(geometry, dict)
    geometry["coordinates"] = [[[10, 10], [50, 10], [50, 12], [10, 12]]]

    with pytest.raises(SiteMapError) as refused:
        parse_site_map(_as_bytes(document))

    assert refused.value.code == "SCHEMA"


def _kind(feature: object) -> str:
    """Reads the kind of a feature of a document, for the tests that edit it.

    Args:
        feature: One feature of the document.

    Returns:
        Its kind, or an empty string when it has none.
    """
    assert isinstance(feature, dict)
    properties = feature["properties"]
    assert isinstance(properties, dict)
    kind = properties["kind"]
    assert isinstance(kind, str)
    return kind


def _as_bytes(document: dict[str, object]) -> bytes:
    """Serialises a document the way a file holds it.

    Args:
        document: The document.

    Returns:
        Its JSON bytes.
    """
    return json.dumps(document).encode("utf-8")
