"""Tests of the grid, the planner and the route book, on the protocol's sample map and small maps.

The property tests are the safety argument of the simulator: a planned path never enters a wall,
a rack or a no-go zone, checked on the raw grid that carries no inflation.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence

import pytest

from fleet_agent.core.model import Point
from fleet_agent.sim.astar import plan_path, simplify
from fleet_agent.sim.grid import CELL_M, OccupancyGrid, build_grid
from fleet_agent.sim.routes import RouteBook
from fleet_agent.sim.site_map import SiteMap, Station, load_site_map
from tests.sim.support import SAMPLE_MAP_PATH

_SAMPLE_STEP_M = 0.1


def _map(
    *,
    walls: Sequence[Sequence[Point]] = (),
    obstacles: Sequence[Sequence[Point]] = (),
    nogos: Sequence[Sequence[Point]] = (),
    bounds: tuple[float, float, float, float] = (0.0, 0.0, 10.0, 10.0),
    stations: Sequence[Station] = (),
) -> SiteMap:
    """Builds a small map directly in the simulator's terms.

    Args:
        walls: The wall polylines.
        obstacles: The obstacle rings, closed.
        nogos: The no-go rings, closed.
        bounds: The bounds of the map.
        stations: The stations; the charger sits at the origin.

    Returns:
        The map.
    """
    return SiteMap(
        charger=Point(1.0, 1.0),
        stations=tuple(stations),
        walls=tuple(tuple(w) for w in walls),
        obstacles=tuple(tuple(o) for o in obstacles),
        nogos=tuple(tuple(n) for n in nogos),
        bounds=bounds,
    )


def _rect(x0: float, y0: float, x1: float, y1: float) -> tuple[Point, ...]:
    """Builds a closed rectangular ring.

    Args:
        x0: Left edge.
        y0: Bottom edge.
        x1: Right edge.
        y1: Top edge.

    Returns:
        The five points of the ring, the first repeated last.
    """
    return (Point(x0, y0), Point(x1, y0), Point(x1, y1), Point(x0, y1), Point(x0, y0))


def _sample_stops(site_map: SiteMap) -> dict[str, Point]:
    """Names the stops of a map the way the fleet does.

    Args:
        site_map: The map.

    Returns:
        The charger and each station, by key.
    """
    stops = {"charger": site_map.charger}
    for station in site_map.stations:
        stops[f"station/{station.name}"] = station.point
    return stops


def _sample_points_along(path: Sequence[Point], step_m: float) -> list[Point]:
    """Samples a polyline at a fixed step, including its ends.

    Args:
        path: The waypoints.
        step_m: The distance between two samples, in metres.

    Returns:
        The samples, in order.
    """
    samples: list[Point] = []
    for a, b in itertools.pairwise(path):
        length = math.hypot(b.x - a.x, b.y - a.y)
        steps = max(1, math.ceil(length / step_m))
        for index in range(steps):
            t = index / steps
            samples.append(Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
    if path:
        samples.append(path[-1])
    return samples


@pytest.fixture(scope="module")
def sample() -> tuple[SiteMap, OccupancyGrid, OccupancyGrid]:
    """Loads the protocol's sample and builds its inflated and raw grids once for the module.

    Returns:
        The map, the inflated grid and the raw grid.
    """
    site_map = load_site_map(SAMPLE_MAP_PATH)
    return site_map, build_grid(site_map), build_grid(site_map, inflate=False)


# Grid -----------------------------------------------------------------------------------------


def test_a_wall_blocks_the_cells_its_centre_line_passes_through() -> None:
    """Given a wall across a map, when rasterised,
    then the cells on its line are blocked and the rest are free."""
    site_map = _map(walls=[(Point(0.0, 5.0), Point(10.0, 5.0))])

    grid = build_grid(site_map, inflate=False)

    assert not grid.point_free(Point(5.0, 5.0))
    assert grid.point_free(Point(5.0, 8.0))
    assert grid.point_free(Point(5.0, 2.0))


def test_a_degenerate_wall_segment_still_blocks_its_point() -> None:
    """Given a wall whose two points coincide, when rasterised, then the single point is blocked."""
    site_map = _map(walls=[(Point(4.0, 4.0), Point(4.0, 4.0))])

    grid = build_grid(site_map, inflate=False)

    assert not grid.point_free(Point(4.0, 4.0))


def test_a_polygon_fills_its_interior_and_leaves_its_exterior_free() -> None:
    """Given a rectangular obstacle, when rasterised,
    then its interior is blocked and the outside free."""
    site_map = _map(obstacles=[_rect(2.0, 2.0, 4.0, 4.0)])

    grid = build_grid(site_map, inflate=False)

    assert not grid.point_free(Point(3.0, 3.0))
    assert grid.point_free(Point(6.0, 6.0))


def test_a_no_go_zone_is_blocked_like_an_obstacle() -> None:
    """Given a no-go rectangle, when rasterised, then its interior is blocked."""
    site_map = _map(nogos=[_rect(6.0, 6.0, 8.0, 8.0)])

    grid = build_grid(site_map, inflate=False)

    assert not grid.point_free(Point(7.0, 7.0))


def test_inflation_widens_obstacles_by_the_robot_radius() -> None:
    """Given an obstacle, when inflated, then a cell at the robot radius away is blocked,
    and one beyond it is free."""
    site_map = _map(obstacles=[_rect(4.0, 4.0, 6.0, 6.0)])

    raw = build_grid(site_map, inflate=False)
    inflated = build_grid(site_map)

    # The obstacle starts at x = 4.0; a cell 0.1 m short of it is within the 0.4 m radius.
    probe = Point(3.9, 5.0)
    assert raw.point_free(probe)
    assert not inflated.point_free(probe)
    assert inflated.point_free(Point(3.0, 5.0))


def test_cells_outside_the_map_are_never_free() -> None:
    """Given a map, when a cell lies outside its bounds, then it is not free."""
    grid = build_grid(_map(), inflate=False)

    assert not grid.is_free(-1, 0)
    assert not grid.is_free(grid.width, 0)
    assert not grid.is_free(0, grid.height)


def test_world_and_cell_coordinates_round_trip_through_the_cell_centre() -> None:
    """Given a grid, when a cell centre is converted to the world and back,
    then the cell is the same."""
    grid = build_grid(_map(), inflate=False)

    centre = grid.cell_to_world(7, 9)

    assert grid.world_to_cell(centre.x, centre.y) == (7, 9)
    assert centre.x == pytest.approx(7.5 * CELL_M)


def test_nearest_free_returns_the_cell_itself_when_it_is_free() -> None:
    """Given a free cell, when asked for the nearest free cell, then it is that cell."""
    grid = build_grid(_map(), inflate=False)

    assert grid.nearest_free(5, 5) == (5, 5)


def test_nearest_free_finds_the_closest_free_cell_outward() -> None:
    """Given a blocked cell surrounded by free ones, when asked,
    then a neighbouring free cell is returned."""
    grid = build_grid(_map(obstacles=[_rect(4.0, 4.0, 4.5, 4.5)]), inflate=False)
    blocked = grid.world_to_cell(4.2, 4.2)

    nearest = grid.nearest_free(*blocked)

    assert nearest is not None
    assert max(abs(nearest[0] - blocked[0]), abs(nearest[1] - blocked[1])) == 1


def test_nearest_free_gives_up_beyond_its_radius() -> None:
    """Given a blocked grid, when asked for a free cell, then none is found."""
    grid = OccupancyGrid(CELL_M, 4, 4, 0.0, 0.0, bytes([1] * 16))

    assert grid.nearest_free(1, 1, max_radius_cells=3) is None


# Planning -------------------------------------------------------------------------------------


def test_every_stop_of_the_sample_map_is_free_after_inflation(
    sample: tuple[SiteMap, OccupancyGrid, OccupancyGrid],
) -> None:
    """Given the sample map, when inflated, then the charger and every station are free."""
    site_map, inflated, _ = sample

    for point in _sample_stops(site_map).values():
        assert inflated.point_free(point)


def test_a_path_exists_between_every_ordered_pair_of_stops_of_the_sample(
    sample: tuple[SiteMap, OccupancyGrid, OccupancyGrid],
) -> None:
    """Given the sample map, when the route book is built,
    then every ordered pair of stops has a route."""
    site_map, inflated, _ = sample

    book = RouteBook.build(inflated, _sample_stops(site_map))

    assert book.unreachable == ()
    assert book.route("charger", "station/dock-a") is not None


@pytest.mark.parametrize(
    ("start", "goal"),
    [
        (Point(3.0, 3.0), Point(52.0, 36.0)),
        (Point(8.0, 36.0), Point(52.0, 6.0)),
        (Point(52.0, 36.0), Point(3.0, 3.0)),
        (Point(30.0, 36.0), Point(8.0, 36.0)),
    ],
)
def test_planned_paths_never_enter_a_wall_a_rack_or_a_no_go_zone(
    sample: tuple[SiteMap, OccupancyGrid, OccupancyGrid],
    start: Point,
    goal: Point,
) -> None:
    """Given a pair of stops, when a path is planned,
    then every sample along it is free in the raw grid."""
    _, inflated, raw = sample
    path = plan_path(inflated, start, goal)

    assert path is not None
    for sample_point in _sample_points_along(path, _SAMPLE_STEP_M):
        assert raw.point_free(sample_point), sample_point


def test_a_planned_path_avoids_the_no_go_rectangle_of_the_sample(
    sample: tuple[SiteMap, OccupancyGrid, OccupancyGrid],
) -> None:
    """Given the sample's no-go zone, when a path crosses the aisle beside it,
    then no sample lies inside it."""
    _, inflated, _ = sample
    path = plan_path(inflated, Point(3.0, 6.0), Point(40.0, 6.0))

    assert path is not None
    for sample_point in _sample_points_along(path, _SAMPLE_STEP_M):
        inside_no_go = 20.0 < sample_point.x < 26.0 and 4.0 < sample_point.y < 8.0
        assert not inside_no_go, sample_point


def test_a_path_in_an_open_area_is_close_to_the_straight_line() -> None:
    """Given a clear space, when a path is planned,
    then it is no longer than 1.3 times the straight line."""
    grid = build_grid(_map(bounds=(0.0, 0.0, 30.0, 30.0)))
    start, goal = Point(2.0, 2.0), Point(28.0, 26.0)

    path = plan_path(grid, start, goal)

    assert path is not None
    length = sum(math.dist((a.x, a.y), (b.x, b.y)) for a, b in itertools.pairwise(path))
    assert length <= 1.3 * math.dist((start.x, start.y), (goal.x, goal.y))


def test_an_unreachable_goal_plans_no_path() -> None:
    """Given a goal walled in by a closed ring, when planned, then there is no path."""
    walls = [_rect(9.0, 9.0, 13.0, 13.0)]
    grid = build_grid(_map(walls=walls, bounds=(0.0, 0.0, 20.0, 20.0)))

    assert plan_path(grid, Point(2.0, 2.0), Point(11.0, 11.0)) is None


def test_a_start_inside_a_blocked_cell_is_moved_to_the_nearest_free_cell() -> None:
    """Given a start on a blocked cell, when planned,
    then the path still begins at the start and succeeds."""
    grid = build_grid(_map(obstacles=[_rect(4.0, 4.0, 6.0, 6.0)]))

    path = plan_path(grid, Point(5.0, 5.0), Point(9.0, 9.0))

    assert path is not None
    assert path[0] == Point(5.0, 5.0)
    assert path[-1] == Point(9.0, 9.0)


def test_a_start_or_goal_with_no_free_cell_nearby_plans_no_path() -> None:
    """Given a fully blocked grid, when planned, then no path is returned."""
    grid = OccupancyGrid(CELL_M, 8, 8, 0.0, 0.0, bytes([1] * 64))

    assert plan_path(grid, Point(0.5, 0.5), Point(1.5, 1.5)) is None


def test_the_path_does_not_cut_a_corner_between_two_blocked_cells() -> None:
    """Given two blocked cells touching at a corner, when planned across them,
    then the diagonal is refused."""
    # 3x3 grid, centre column blocked except at the top and bottom: the only way across is around.
    blocked = bytearray(9)
    blocked[1] = 1  # (1, 0)
    blocked[7] = 1  # (1, 2)
    grid = OccupancyGrid(1.0, 3, 3, 0.0, 0.0, bytes(blocked))

    path = plan_path(grid, Point(0.5, 0.5), Point(2.5, 0.5))

    assert path is not None
    assert all(grid.point_free(point) for point in _sample_points_along(path, 0.1))
    assert all(grid.point_free(corner) for corner in path)


def test_planning_is_deterministic() -> None:
    """Given the same map and points, when planned twice, then the two paths are identical."""
    grid = build_grid(_map(obstacles=[_rect(4.0, 0.0, 5.0, 7.0)], bounds=(0.0, 0.0, 12.0, 12.0)))

    first = plan_path(grid, Point(1.0, 1.0), Point(10.0, 10.0))
    second = plan_path(grid, Point(1.0, 1.0), Point(10.0, 10.0))

    assert first == second


def test_simplify_keeps_only_the_corners_of_an_open_path() -> None:
    """Given a path that is straight on a clear grid, when simplified, then only its ends remain."""
    grid = build_grid(_map(bounds=(0.0, 0.0, 10.0, 10.0)))
    path = [Point(1.0, 5.0), Point(2.0, 5.0), Point(3.0, 5.0), Point(4.0, 5.0)]

    assert simplify(grid, path) == [Point(1.0, 5.0), Point(4.0, 5.0)]


def test_simplify_leaves_a_short_path_alone() -> None:
    """Given a path of two points, when simplified, then it is returned unchanged."""
    grid = build_grid(_map())
    path = [Point(1.0, 1.0), Point(2.0, 2.0)]

    assert simplify(grid, path) == path


# Route book ----------------------------------------------------------------------------------


def test_the_route_book_holds_a_route_for_every_ordered_pair_of_stops(
    sample: tuple[SiteMap, OccupancyGrid, OccupancyGrid],
) -> None:
    """Given five stops, when the book is built, then it holds the 20 ordered pairs."""
    site_map, inflated, _ = sample
    stops = _sample_stops(site_map)

    book = RouteBook.build(inflated, stops)

    assert len(stops) == 5
    assert sum(1 for a in stops for b in stops if a != b and book.route(a, b) is not None) == 20
    assert book.route("charger", "charger") is None


def test_the_route_book_lists_a_stop_it_cannot_reach() -> None:
    """Given a station sealed inside a wall, when the book is built,
    then the pairs to it are unreachable."""
    sealed = Point(20.0, 20.0)
    walls = [_rect(18.0, 18.0, 22.0, 22.0)]
    site_map = _map(walls=walls, bounds=(0.0, 0.0, 40.0, 40.0))
    grid = build_grid(site_map)
    stops = {"charger": Point(2.0, 2.0), "station/sealed": sealed}

    book = RouteBook.build(grid, stops)

    assert ("charger", "station/sealed") in book.unreachable
    assert ("station/sealed", "charger") in book.unreachable


def test_stop_key_of_finds_a_stop_only_within_the_tolerance() -> None:
    """Given a book, when a point is near a stop,
    then that stop is found; a far point finds none."""
    grid = build_grid(_map(bounds=(0.0, 0.0, 10.0, 10.0)))
    book = RouteBook.build(grid, {"charger": Point(1.0, 1.0), "station/a": Point(8.0, 8.0)})

    assert book.stop_key_of(Point(1.3, 1.2)) == "charger"
    assert book.stop_key_of(Point(4.0, 4.0)) is None
