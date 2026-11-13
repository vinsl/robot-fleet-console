"""Path planning on the occupancy grid: 8-connected A* and a line-of-sight simplification.

The planner never cuts a corner: a diagonal step is allowed only when both orthogonal cells beside
it are free. The result is deterministic, because the heap orders ties by cell index.
"""

from __future__ import annotations

import heapq
import math
from typing import Final

from fleet_agent.core.model import Point
from fleet_agent.sim.grid import OccupancyGrid

_SQRT2: Final = math.sqrt(2.0)
_MOVES: Final[tuple[tuple[int, int, float], ...]] = (
    (1, 0, 1.0),
    (-1, 0, 1.0),
    (0, 1, 1.0),
    (0, -1, 1.0),
    (1, 1, _SQRT2),
    (1, -1, _SQRT2),
    (-1, 1, _SQRT2),
    (-1, -1, _SQRT2),
)
"""The eight neighbours of a cell, with the cost of a step to each, in cells."""

_SEARCH_RADIUS_CELLS: Final = 8
"""How far a start or goal outside the free space is moved to a free cell, in cells."""

_LINE_SAMPLES_PER_CELL: Final = 4
"""Samples per cell along a line-of-sight test, so a thin blocked cell cannot slip between two."""


def plan_path(grid: OccupancyGrid, start: Point, goal: Point) -> list[Point] | None:
    """Plans a path between two points over the free cells of the grid.

    The start and the goal are moved to the nearest free cell when they lie in a blocked one, so
    a robot a few centimetres inside an inflated zone can still plan. The path begins at the
    exact start and ends at the exact goal, and is simplified to its corners.

    Args:
        grid: The inflated occupancy grid.
        start: Where the path begins, in metres.
        goal: Where the path ends, in metres.

    Returns:
        The waypoints from start to goal, or None when no free path exists or the search is
        bigger than the grid itself.
    """
    start_cell = grid.nearest_free(*grid.world_to_cell(start.x, start.y), _SEARCH_RADIUS_CELLS)
    goal_cell = grid.nearest_free(*grid.world_to_cell(goal.x, goal.y), _SEARCH_RADIUS_CELLS)
    if start_cell is None or goal_cell is None:
        return None
    cells = _search(grid, start_cell, goal_cell)
    if cells is None:
        return None
    centres = [grid.cell_to_world(ix, iy) for ix, iy in cells]
    path = [start, *centres[1:-1], goal] if len(centres) > 1 else [start, goal]
    return simplify(grid, path)


def simplify(grid: OccupancyGrid, path: list[Point]) -> list[Point]:
    """Keeps only the corners of a path: each kept point sees the next kept one in a straight line.

    From each kept point the walk extends as far as the straight line stays free, then keeps the
    last point it could see. The first and the last point are always kept.

    Args:
        grid: The grid the line of sight is checked on.
        path: The path to simplify, at least two points.

    Returns:
        The corners of the path, in order.
    """
    if len(path) <= 2:
        return list(path)
    kept = [path[0]]
    anchor = 0
    last = len(path) - 1
    while anchor < last:
        reach = anchor + 1
        while reach + 1 <= last and _line_is_free(grid, path[anchor], path[reach + 1]):
            reach += 1
        kept.append(path[reach])
        anchor = reach
    return kept


def _line_is_free(grid: OccupancyGrid, a: Point, b: Point) -> bool:
    """Tells whether the straight line between two points stays in free cells, sampled finely.

    Args:
        grid: The grid.
        a: One end of the line.
        b: The other end of the line.

    Returns:
        True when every sample lies in a free cell.
    """
    length = math.hypot(b.x - a.x, b.y - a.y)
    steps = max(1, math.ceil(length / (grid.cell_m / _LINE_SAMPLES_PER_CELL)))
    for step in range(steps + 1):
        t = step / steps
        if not grid.point_free(Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)):
            return False
    return True


def _search(
    grid: OccupancyGrid, start: tuple[int, int], goal: tuple[int, int]
) -> list[tuple[int, int]] | None:
    """Runs A* over the cells, with the octile heuristic, and returns the cells from start to goal.

    Args:
        grid: The grid.
        start: The starting cell, free.
        goal: The goal cell, free.

    Returns:
        The cells of the path, or None when the goal cannot be reached.
    """
    width = grid.width
    start_index = start[1] * width + start[0]
    goal_index = goal[1] * width + goal[0]
    best: dict[int, float] = {start_index: 0.0}
    came_from: dict[int, int] = {}
    closed: set[int] = set()
    heap: list[tuple[float, int]] = [(_octile(start, goal), start_index)]
    while heap:
        _, current = heapq.heappop(heap)
        if current in closed:
            continue
        if current == goal_index:
            return _rebuild(came_from, current, width)
        closed.add(current)
        ix, iy = current % width, current // width
        for dx, dy, cost in _MOVES:
            nx, ny = ix + dx, iy + dy
            if not grid.is_free(nx, ny):
                continue
            if (
                dx != 0
                and dy != 0
                and not (grid.is_free(ix + dx, iy) and grid.is_free(ix, iy + dy))
            ):
                continue
            neighbour = ny * width + nx
            if neighbour in closed:
                continue
            tentative = best[current] + cost
            if tentative < best.get(neighbour, math.inf):
                best[neighbour] = tentative
                came_from[neighbour] = current
                heapq.heappush(heap, (tentative + _octile((nx, ny), goal), neighbour))
    return None


def _octile(cell: tuple[int, int], goal: tuple[int, int]) -> float:
    """The octile distance between two cells, the admissible heuristic of the 8-connected search.

    Args:
        cell: The cell being measured.
        goal: The goal cell.

    Returns:
        The distance in cells, with a diagonal step costing the square root of two.
    """
    dx = abs(cell[0] - goal[0])
    dy = abs(cell[1] - goal[1])
    return max(dx, dy) + (_SQRT2 - 1.0) * min(dx, dy)


def _rebuild(came_from: dict[int, int], current: int, width: int) -> list[tuple[int, int]]:
    """Walks the parent links back from the goal and returns the cells in order.

    Args:
        came_from: The parent of every reached cell, by index.
        current: The goal index.
        width: The number of columns, to turn an index back into a cell.

    Returns:
        The cells from the start to the goal, inclusive.
    """
    indices = [current]
    while current in came_from:
        current = came_from[current]
        indices.append(current)
    indices.reverse()
    return [(index % width, index // width) for index in indices]
