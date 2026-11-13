"""The site map of the simulator: a strict Python mirror of the GeoJSON contract of the protocol.

The contract is written once, in `packages/protocol/src/site-map.ts`. This module repeats its rules
in pydantic, so that the simulator refuses in Python what the console refuses in TypeScript. The
parity tests load the same fixtures in both languages and expect the same verdict. The simulator
adds two limits of its own: a map at most 200 m across (its grid is sized for it) and no symlink
(the file is read exactly as it was named).
"""

from __future__ import annotations

import errno
import math
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)

from fleet_agent.core.model import Point

SITE_MAP_MAX_BYTES: Final = 2_000_000
"""Largest accepted map, in bytes. The same bound as the console's schema."""

SIM_MAX_EXTENT_M: Final = 200.0
"""Largest extent of the map along each axis, in metres. The simulator's grid is sized for it."""

_MAX_FEATURES: Final = 5000
_MAX_VERTICES: Final = 50_000
_COORDINATE_BOUND_M: Final = 1000.0
_MIN_WORKSTATIONS: Final = 2
_SIZE_MIN_M: Final = 0.1
_SIZE_MAX_M: Final = 50.0

_NAME_PATTERN: Final = r"^[a-z0-9-]{1,32}$"
Name = Annotated[str, StringConstraints(strict=True, pattern=_NAME_PATTERN)]
Coordinate = Annotated[
    float,
    Field(ge=-_COORDINATE_BOUND_M, le=_COORDINATE_BOUND_M, allow_inf_nan=False),
]


def _closed_ring(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Refuses a polygon ring whose first and last positions differ.

    Args:
        ring: The ring as parsed. Its length is already checked by the schema.

    Returns:
        The ring, unchanged, when it is closed.

    Raises:
        ValueError: When the ring is not closed.
    """
    if ring[0] != ring[-1]:
        raise ValueError("a polygon ring must be closed")
    return ring


Position = tuple[Coordinate, Coordinate]
ClosedRing = Annotated[
    list[Position],
    Field(min_length=4),
    AfterValidator(_closed_ring),
]


class _Model(BaseModel):
    """Base of the strict schema models: no coercion, no unknown keys, immutable once parsed."""

    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class _FleetFrame(_Model):
    """The `fleet` member that names the local metric frame."""

    crs: Literal["local-metric"]
    version: int = Field(ge=1)


class _LineGeometry(_Model):
    """The geometry of a wall: a polyline of at least two positions."""

    type: Literal["LineString"]
    coordinates: list[Position] = Field(min_length=2)


class _PolygonGeometry(_Model):
    """The geometry of an obstacle or a no-go zone: one closed ring."""

    type: Literal["Polygon"]
    coordinates: tuple[ClosedRing]


class _PointGeometry(_Model):
    """The geometry of the charger and of a workstation: one position."""

    type: Literal["Point"]
    coordinates: Position


class _WallProperties(_Model):
    """Properties of a wall feature."""

    kind: Literal["wall"]
    name: Name | None = None


class _ObstacleProperties(_Model):
    """Properties of an obstacle feature."""

    kind: Literal["obstacle"]
    name: Name | None = None


class _NogoProperties(_Model):
    """Properties of a no-go feature."""

    kind: Literal["nogo"]
    name: Name | None = None


class _ChargerProperties(_Model):
    """Properties of the charger feature."""

    kind: Literal["charger"]
    name: Name | None = None


class _Size(_Model):
    """The optional footprint of a workstation, in metres, with the protocol's bounds."""

    width: float = Field(ge=_SIZE_MIN_M, le=_SIZE_MAX_M, allow_inf_nan=False)
    height: float = Field(ge=_SIZE_MIN_M, le=_SIZE_MAX_M, allow_inf_nan=False)


class _WorkstationProperties(_Model):
    """Properties of a workstation feature; its name is required, its footprint is optional."""

    kind: Literal["workstation"]
    name: Name
    size: _Size | None = None


class _Feature(_Model):
    """A feature with a geometry and properties of a given type, checked by the caller."""

    type: Literal["Feature"]


class _WallFeature(_Feature):
    """A wall: a LineString with the `wall` kind."""

    geometry: _LineGeometry
    properties: _WallProperties


class _ObstacleFeature(_Feature):
    """An obstacle: one closed polygon with the `obstacle` kind."""

    geometry: _PolygonGeometry
    properties: _ObstacleProperties


class _NogoFeature(_Feature):
    """A no-go zone: one closed polygon with the `nogo` kind."""

    geometry: _PolygonGeometry
    properties: _NogoProperties


class _ChargerFeature(_Feature):
    """The charger: a point with the `charger` kind."""

    geometry: _PointGeometry
    properties: _ChargerProperties


class _WorkstationFeature(_Feature):
    """A workstation: a named point with the `workstation` kind."""

    geometry: _PointGeometry
    properties: _WorkstationProperties


_AnyFeature = _WallFeature | _ObstacleFeature | _NogoFeature | _ChargerFeature | _WorkstationFeature


class _Collection(_Model):
    """The whole document: a FeatureCollection in the local metric frame."""

    type: Literal["FeatureCollection"]
    fleet: _FleetFrame
    features: list[_AnyFeature] = Field(max_length=_MAX_FEATURES)


class SiteMapError(Exception):
    """The site map cannot be used. Its string form names the rule, never a value.

    Attributes:
        code: The failed check, a fixed word.
        detail: The dotted path of the field that failed, when the check had one.
    """

    def __init__(self, code: str, detail: str | None = None) -> None:
        """Creates the error.

        Args:
            code: The failed check.
            detail: The field that failed, if any. It is a path, never a value.
        """
        super().__init__(code if detail is None else f"{code} at {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class Station:
    """A named workstation where a mission starts or ends.

    Attributes:
        name: The workstation's name, unique in the map.
        point: Its position, in metres. The mission target; the footprint does not move it.
        size: The footprint's width and height in metres, centred on the point, or None when the
            workstation has no footprint. Information only: the planner does not read it.
    """

    name: str
    point: Point
    size: tuple[float, float] | None = None


@dataclass(frozen=True, slots=True)
class SiteMap:
    """A validated site map, in the simulator's terms.

    Attributes:
        charger: The position where robots recharge.
        stations: The workstations, in the order of the file, names unique.
        walls: Each wall as its polyline of points.
        obstacles: Each obstacle as its closed ring of points.
        nogos: Each no-go zone as its closed ring of points.
        bounds: The minimum x, minimum y, maximum x and maximum y over every position and every
            corner of a workstation footprint, so the grid covers what the map draws.
    """

    charger: Point
    stations: tuple[Station, ...]
    walls: tuple[tuple[Point, ...], ...]
    obstacles: tuple[tuple[Point, ...], ...]
    nogos: tuple[tuple[Point, ...], ...]
    bounds: tuple[float, float, float, float]


def parse_site_map(text: bytes) -> SiteMap:
    """Parses and checks the bytes of a map, then converts it to the simulator's terms.

    The size is checked before the JSON is read, and the JSON is read in its own mode, so a number
    too large for a float (which would become infinity) is refused by the bounds.

    Args:
        text: The document as read from the file.

    Returns:
        The validated map.

    Raises:
        SiteMapError: When the document is too large, not JSON, not UTF-8, violates the schema, or
            breaks a cross-feature rule or the simulator's extent limit.
    """
    if len(text) > SITE_MAP_MAX_BYTES:
        raise SiteMapError("TOO_LARGE")
    try:
        collection = _Collection.model_validate_json(text)
    except ValidationError as err:
        first = err.errors(include_input=False, include_url=False)[0]
        if first["type"] == "json_invalid":
            raise SiteMapError("NOT_JSON") from None
        detail = ".".join(str(part) for part in first["loc"])
        raise SiteMapError("SCHEMA", detail) from None
    return _to_site_map(collection)


def load_site_map(path: Path) -> SiteMap:
    """Reads a map from a file that is not a symbolic link, then parses it.

    The file is opened without following a link, so the file read is the one named, and it is
    refused unless it is a regular file within the size limit.

    Args:
        path: The map file.

    Returns:
        The validated map.

    Raises:
        SiteMapError: When the file is a link, missing, not a regular file, too large, or invalid.
    """
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as err:
        if err.errno == errno.ELOOP:
            raise SiteMapError("SYMLINK") from None
        raise SiteMapError("UNREADABLE") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SiteMapError("NOT_A_FILE")
        if info.st_size > SITE_MAP_MAX_BYTES:
            raise SiteMapError("TOO_LARGE")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            data = handle.read(SITE_MAP_MAX_BYTES + 1)
    finally:
        os.close(fd)
    return parse_site_map(data)


def _to_site_map(collection: _Collection) -> SiteMap:
    """Checks the cross-feature rules and converts the document to the simulator's terms.

    Args:
        collection: The schema-valid document.

    Returns:
        The map in the simulator's terms.

    Raises:
        SiteMapError: When the charger count, the workstations, the vertex count or the extent
            breaks its rule.
    """
    chargers = [f for f in collection.features if isinstance(f, _ChargerFeature)]
    if len(chargers) != 1:
        raise SiteMapError("CHARGER_COUNT", "features")
    workstations = [f for f in collection.features if isinstance(f, _WorkstationFeature)]
    if len(workstations) < _MIN_WORKSTATIONS:
        raise SiteMapError("WORKSTATION_COUNT", "features")
    names = [f.properties.name for f in workstations]
    if len(set(names)) != len(names):
        raise SiteMapError("WORKSTATION_NAMES", "features")

    walls = tuple(
        _points(f.geometry.coordinates) for f in collection.features if isinstance(f, _WallFeature)
    )
    obstacles = tuple(
        _points(f.geometry.coordinates[0])
        for f in collection.features
        if isinstance(f, _ObstacleFeature)
    )
    nogos = tuple(
        _points(f.geometry.coordinates[0])
        for f in collection.features
        if isinstance(f, _NogoFeature)
    )
    charger_position = chargers[0].geometry.coordinates
    stations = tuple(
        Station(
            name=f.properties.name,
            point=_point(f.geometry.coordinates),
            size=_size(f.properties.size),
        )
        for f in workstations
    )

    every = [position for ring in (*walls, *obstacles, *nogos) for position in ring]
    every.append(_point(charger_position))
    every.extend(station.point for station in stations)
    if sum(len(ring) for ring in (*walls, *obstacles, *nogos)) + 1 + len(stations) > _MAX_VERTICES:
        raise SiteMapError("VERTEX_COUNT", "features")
    # The footprint corners count for the extent, not for the vertex count: a bay is not a vertex.
    extent_points = [*every, *(corner for station in stations for corner in _corners(station))]
    xs = [p.x for p in extent_points]
    ys = [p.y for p in extent_points]
    bounds = (min(xs), min(ys), max(xs), max(ys))
    if bounds[2] - bounds[0] > SIM_MAX_EXTENT_M or bounds[3] - bounds[1] > SIM_MAX_EXTENT_M:
        raise SiteMapError("EXTENT", "features")
    return SiteMap(
        charger=_point(charger_position),
        stations=stations,
        walls=walls,
        obstacles=obstacles,
        nogos=nogos,
        bounds=bounds,
    )


def _point(position: Position) -> Point:
    """Converts one schema position to a point.

    Args:
        position: The `[x, y]` pair, already bounded by the schema.

    Returns:
        The point.
    """
    x, y = position
    if not (math.isfinite(x) and math.isfinite(y)):
        raise SiteMapError("NON_FINITE")
    return Point(x, y)


def _size(size: _Size | None) -> tuple[float, float] | None:
    """Converts an optional footprint to a plain pair of metres.

    Args:
        size: The footprint as parsed, or None when the workstation has none.

    Returns:
        The width and height, or None.
    """
    if size is None:
        return None
    return (size.width, size.height)


def _corners(station: Station) -> tuple[Point, ...]:
    """Lists the four corners of a station's footprint, or no point when it has none.

    Args:
        station: One workstation of the map.

    Returns:
        The corners of its footprint, centred on its point; empty when it has no footprint.
    """
    if station.size is None:
        return ()
    width, height = station.size
    x, y = station.point.x, station.point.y
    half_w = width / 2
    half_h = height / 2
    return (
        Point(x - half_w, y - half_h),
        Point(x + half_w, y - half_h),
        Point(x + half_w, y + half_h),
        Point(x - half_w, y + half_h),
    )


def _points(positions: list[Position] | tuple[Position, ...]) -> tuple[Point, ...]:
    """Converts a list of schema positions to points, in order.

    Args:
        positions: The positions of one geometry.

    Returns:
        The points, in the same order.
    """
    return tuple(_point(position) for position in positions)
