"""The occupancy grid of the simulator: the site map rasterised, then inflated by the robot radius.

Cells are square, 0.25 m by default. A cell is blocked when it is a wall, an obstacle or a no-go
zone, or when a blocked cell lies within the robot's radius of it. A path that keeps to free cells
therefore keeps the robot's body clear of every wall, rack and no-go zone. Rasterisation is
conservative: a wall blocks every cell its centre line passes near, so the grid never shows a gap
the robot could not fit through.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final

from fleet_agent.core.model import Point
from fleet_agent.sim.site_map import SiteMap

CELL_M: Final = 0.25
"""Edge of one grid cell, in metres."""

ROBOT_RADIUS_M: Final = 0.4
"""Radius of the robot's body, in metres. Free cells are at least this far from any obstacle."""

WALL_HALF_WIDTH_M: Final = 0.1
"""Half the thickness of a wall, in metres."""

_GRID_MARGIN_CELLS: Final = 1


@dataclass(frozen=True, slots=True)
class OccupancyGrid:
    """A grid of square cells, each free or blocked, with its origin in the site frame.

    Attributes:
        cell_m: The edge of one cell, in metres.
        width: The number of cells along x.
        height: The number of cells along y.
        origin_x: The x coordinate of the lower edge of cell column 0, in metres.
        origin_y: The y coordinate of the lower edge of cell row 0, in metres.
        blocked: One byte per cell in row-major order, 1 when blocked and 0 when free.
    """

    cell_m: float
    width: int
    height: int
    origin_x: float
    origin_y: float
    blocked: bytes

    def is_free(self, ix: int, iy: int) -> bool:
        """Tells whether a cell lies inside the grid and is free.

        Args:
            ix: The column of the cell.
            iy: The row of the cell.

        Returns:
            True when the cell is inside the grid and not blocked. Cells outside are never free.
        """
        if not (0 <= ix < self.width and 0 <= iy < self.height):
            return False
        return self.blocked[iy * self.width + ix] == 0

    def world_to_cell(self, x: float, y: float) -> tuple[int, int]:
        """Returns the cell that contains a point. The point may lie outside the grid.

        Args:
            x: The x coordinate, in metres.
            y: The y coordinate, in metres.

        Returns:
            The column and the row of the cell containing the point.
        """
        return (
            math.floor((x - self.origin_x) / self.cell_m),
            math.floor((y - self.origin_y) / self.cell_m),
        )

    def cell_to_world(self, ix: int, iy: int) -> Point:
        """Returns the centre of a cell in the site frame.

        Args:
            ix: The column of the cell.
            iy: The row of the cell.

        Returns:
            The centre of the cell, in metres.
        """
        return Point(
            self.origin_x + (ix + 0.5) * self.cell_m,
            self.origin_y + (iy + 0.5) * self.cell_m,
        )

    def point_free(self, point: Point) -> bool:
        """Tells whether the cell that contains a point is free.

        Args:
            point: The point, in metres.

        Returns:
            True when the cell containing the point is free.
        """
        return self.is_free(*self.world_to_cell(point.x, point.y))

    def nearest_free(self, ix: int, iy: int, max_radius_cells: int = 8) -> tuple[int, int] | None:
        """Finds the free cell nearest to a cell, searching outwards ring by ring.

        Args:
            ix: The column to start from. It may lie outside the grid.
            iy: The row to start from. It may lie outside the grid.
            max_radius_cells: The farthest ring searched, in cells.

        Returns:
            The nearest free cell, or None when no free cell lies within the search radius.
        """
        if self.is_free(ix, iy):
            return ix, iy
        for radius in range(1, max_radius_cells + 1):
            best: tuple[int, int] | None = None
            best_distance = math.inf
            for dx, dy in _ring(radius):
                cx, cy = ix + dx, iy + dy
                if not self.is_free(cx, cy):
                    continue
                distance = dx * dx + dy * dy
                if distance < best_distance:
                    best, best_distance = (cx, cy), distance
            if best is not None:
                return best
        return None


def build_grid(
    site_map: SiteMap,
    *,
    robot_radius_m: float = ROBOT_RADIUS_M,
    cell_m: float = CELL_M,
    inflate: bool = True,
) -> OccupancyGrid:
    """Rasterises a map and, unless asked not to, inflates its obstacles by the robot's radius.

    Cells outside the map's bounds are never free: the grid covers the bounds and no more.

    Args:
        site_map: The validated map.
        robot_radius_m: The radius inflated around every blocked cell, in metres.
        cell_m: The edge of one cell, in metres, positive.
        inflate: Whether to inflate. The raw grid is used by the tests that check the path itself.

    Returns:
        The occupancy grid.
    """
    min_x, min_y, max_x, max_y = site_map.bounds
    width = math.ceil((max_x - min_x) / cell_m) + _GRID_MARGIN_CELLS
    height = math.ceil((max_y - min_y) / cell_m) + _GRID_MARGIN_CELLS
    grid = OccupancyGrid(
        cell_m=cell_m,
        width=width,
        height=height,
        origin_x=min_x,
        origin_y=min_y,
        blocked=bytes(width * height),
    )
    raw = bytearray(width * height)
    for wall in site_map.walls:
        for start, end in itertools.pairwise(wall):
            _mark_segment(raw, grid, start, end)
    for ring in (*site_map.obstacles, *site_map.nogos):
        _fill_ring(raw, grid, ring)
    if inflate:
        raw = _inflate(raw, width, height, robot_radius_m / cell_m)
    return OccupancyGrid(
        cell_m=cell_m,
        width=width,
        height=height,
        origin_x=min_x,
        origin_y=min_y,
        blocked=bytes(raw),
    )


def _ring(radius: int) -> Iterable[tuple[int, int]]:
    """Lists the offsets of the square ring at a Chebyshev distance from the origin.

    Args:
        radius: The distance of the ring, in cells, positive.

    Returns:
        The offsets of every cell on the ring.
    """
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            if max(abs(dx), abs(dy)) == radius:
                yield dx, dy


def _mark_segment(raw: bytearray, grid: OccupancyGrid, start: Point, end: Point) -> None:
    """Blocks every cell whose centre lies within the wall's half-thickness of a segment.

    The half-thickness is widened by half a cell, so a cell the wall touches is blocked.

    Args:
        raw: The blocked bytes being filled.
        grid: The grid, which gives the cell geometry.
        start: One end of the segment.
        end: The other end of the segment.
    """
    reach = WALL_HALF_WIDTH_M + grid.cell_m / 2
    min_ix, min_iy = grid.world_to_cell(min(start.x, end.x) - reach, min(start.y, end.y) - reach)
    max_ix, max_iy = grid.world_to_cell(max(start.x, end.x) + reach, max(start.y, end.y) + reach)
    for iy in range(max(min_iy, 0), min(max_iy, grid.height - 1) + 1):
        for ix in range(max(min_ix, 0), min(max_ix, grid.width - 1) + 1):
            centre = grid.cell_to_world(ix, iy)
            if _distance_to_segment(centre, start, end) <= reach:
                raw[iy * grid.width + ix] = 1


def _distance_to_segment(point: Point, start: Point, end: Point) -> float:
    """Measures the distance from a point to a segment.

    Args:
        point: The point.
        start: One end of the segment.
        end: The other end of the segment.

    Returns:
        The shortest distance, in metres.
    """
    dx = end.x - start.x
    dy = end.y - start.y
    length_sq = dx * dx + dy * dy
    if length_sq == 0.0:
        return math.hypot(point.x - start.x, point.y - start.y)
    t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length_sq
    t = min(max(t, 0.0), 1.0)
    return math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))


def _fill_ring(raw: bytearray, grid: OccupancyGrid, ring: tuple[Point, ...]) -> None:
    """Blocks every cell whose centre lies inside a closed ring, by a scanline fill.

    Each row is crossed by the ring's edges at the height of the row's centre, and the cells
    between each pair of crossings (taken in order) are inside the ring.

    Args:
        raw: The blocked bytes being filled.
        grid: The grid, which gives the cell geometry.
        ring: The closed ring, its last point equal to its first.
    """
    ys = [p.y for p in ring]
    first_row = max(math.ceil((min(ys) - grid.origin_y) / grid.cell_m - 0.5), 0)
    last_row = min(math.floor((max(ys) - grid.origin_y) / grid.cell_m - 0.5), grid.height - 1)
    edges = list(itertools.pairwise(ring))
    for iy in range(first_row, last_row + 1):
        yc = grid.origin_y + (iy + 0.5) * grid.cell_m
        crossings = sorted(
            _crossing_x(a, b, yc) for a, b in edges if (a.y <= yc < b.y) or (b.y <= yc < a.y)
        )
        for left, right in zip(crossings[0::2], crossings[1::2], strict=False):
            first_col = max(math.ceil((left - grid.origin_x) / grid.cell_m - 0.5), 0)
            last_col = min(
                math.ceil((right - grid.origin_x) / grid.cell_m - 0.5) - 1, grid.width - 1
            )
            for ix in range(first_col, last_col + 1):
                raw[iy * grid.width + ix] = 1


def _crossing_x(a: Point, b: Point, y: float) -> float:
    """Finds where an edge crosses a horizontal line.

    Args:
        a: One end of the edge, with a y different from the other end.
        b: The other end of the edge.
        y: The height of the line.

    Returns:
        The x coordinate of the crossing.
    """
    return a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)


def _inflate(raw: bytearray, width: int, height: int, radius_cells: float) -> bytearray:
    """Blocks every cell within a radius of a blocked cell, with a circular kernel.

    Args:
        raw: The raw blocked bytes.
        width: The number of columns.
        height: The number of rows.
        radius_cells: The radius, in cells.

    Returns:
        A new array with the inflated obstacles.
    """
    reach = math.ceil(radius_cells)
    kernel = [
        (dx, dy)
        for dx in range(-reach, reach + 1)
        for dy in range(-reach, reach + 1)
        if dx * dx + dy * dy <= radius_cells * radius_cells
    ]
    out = bytearray(raw)
    for index, value in enumerate(raw):
        if value == 0:
            continue
        ix, iy = index % width, index // width
        for dx, dy in kernel:
            nx, ny = ix + dx, iy + dy
            if 0 <= nx < width and 0 <= ny < height:
                out[ny * width + nx] = 1
    return out
