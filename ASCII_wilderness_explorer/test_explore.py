"""
Quick checks. Run with:  python3 -m pytest -q

Most of these exist so you can add silly things to content.py and find out
right away if something is off (a typo'd biome, art with an unreachable '?').
"""

import json
import random
from collections import deque

import pytest

import content
import explore
import worldgen

TERRAIN_KINDS = set(content.TERRAIN)
ODDITY_BIOMES = set(content.LAND) | {"cave"}


# ---- content sanity ---------------------------------------------------------
def test_terrain_entries_are_well_formed():
    for kind, t in content.TERRAIN.items():
        assert t["glyphs"], kind
        assert all(32 < ord(c) < 127 for c in t["glyphs"]), f"{kind}: glyphs must be printable ASCII"
        assert t["color"] in explore.PALETTE, f"{kind}: unknown color {t['color']!r}"
    assert content.LAND <= TERRAIN_KINDS


MAX_TEXT = 150   # messages wrap onto two lines of an 80-column terminal


@pytest.mark.parametrize("odd", worldgen.ODDITIES, ids=lambda o: str(o.get("text", o))[:40])
def test_oddities_are_well_formed(odd):
    assert str(odd.get("text", "")).strip(), "every discovery needs a \"text\""
    assert len(odd["text"]) <= MAX_TEXT, f"too long to show ({len(odd['text'])} > {MAX_TEXT})"
    assert set(odd.get("biomes") or ()) <= ODDITY_BIOMES, \
        f"unknown biome(s): {set(odd['biomes']) - ODDITY_BIOMES}"
    effect = odd.get("effect")
    if isinstance(effect, str):
        assert callable(getattr(content, effect, None)), f"no effect function named {effect!r}"
    else:
        assert effect is None or callable(effect)


def test_every_place_has_something_odd():
    for biome in ODDITY_BIOMES:
        assert worldgen.ODDITY_POOLS.get(biome), f"no oddities can appear in {biome}"


def _reachable_from_outside(rows):
    """All non-wall cells of the art reachable from outside its bounding box."""
    h, w = len(rows), max(len(r) for r in rows)
    grid = [r.ljust(w) for r in rows]
    open_ = {(x, y) for y in range(h) for x in range(w) if grid[y][x] != "#"}
    frontier = deque((x, y) for (x, y) in open_ if x in (0, w - 1) or y in (0, h - 1))
    seen = set(frontier)
    while frontier:
        x, y = frontier.popleft()
        for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if n in open_ and n not in seen:
                seen.add(n)
                frontier.append(n)
    return seen, grid


@pytest.mark.parametrize("spec", content.STRUCTURES, ids=lambda s: str(s.get("name", "?")))
def test_structures_are_well_formed(spec):
    assert spec.get("name") and spec.get("art") and spec.get("biomes"), "needs name, art and biomes"
    rows = worldgen._parse_art(spec["art"])
    assert rows, "art is empty"
    w, h = max(len(r) for r in rows), len(rows)
    assert max(w, h) <= worldgen.REGION - 4, f"art is too big ({w}x{h})"
    assert all(32 <= ord(c) < 127 for r in rows for c in r), "art must be plain ASCII (no tabs)"
    assert not isinstance(spec["biomes"], str), "biomes must be a set like {\"meadow\"}"
    assert set(spec["biomes"]) <= content.LAND, f"unknown biome(s): {set(spec['biomes']) - content.LAND}"
    color = spec.get("color", "brown")
    assert color in explore.PALETTE, f"unknown color {color!r}"
    assert 0 <= spec.get("decay", 0) <= 1
    assert len(spec.get("text", "")) <= MAX_TEXT
    seen, grid = _reachable_from_outside(rows)
    edge = rows[0] + rows[-1] + "".join(r[:1] + r[w - 1:] for r in grid)
    assert "?" not in edge, "keep '?' off the edge so the place is announced first"
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch in ".?+":
                assert (x, y) in seen, f"{ch!r} at column {x}, row {y} is walled in"


def test_flavor_text():
    assert set(content.AMBIENT) <= TERRAIN_KINDS | {"night"}, "AMBIENT keys must be terrain names"
    for lines in content.AMBIENT.values():
        assert all(len(line) <= MAX_TEXT for line in lines)
    for line in content.COMPANION_CHATTER:
        assert "{name}" in line, f"chatter needs a {{name}}: {line!r}"
    assert content.ENTER_CAVE and content.DREAMS
    assert all(d.endswith(".") for d in content.DREAMS)


# ---- world generation ---------------------------------------------------------
def test_same_seed_same_world():
    a, b = worldgen.World(5), worldgen.World(5)
    for y in range(-70, 70, 7):
        for x in range(-70, 70, 3):
            assert a.cell(x, y) == b.cell(x, y)


def test_different_seeds_differ():
    a, b = worldgen.World(1), worldgen.World(2)
    cells = [(x, y) for x in range(0, 200, 5) for y in range(0, 200, 5)]
    assert sum(a.cell(*p)[0] != b.cell(*p)[0] for p in cells) > len(cells) // 4


def test_structures_stay_in_their_region():
    w = worldgen.World(3)
    for rx in range(-8, 8):
        for ry in range(-8, 8):
            s = w.structure(rx, ry)
            for x, y in (s["cells"] if s else ()):
                assert (x // worldgen.REGION, y // worldgen.REGION) == (rx, ry)


def test_huge_coordinates_work():
    w = worldgen.World(9)
    for x, y in ((10**9, -10**9), (-123456789, 987654321)):
        assert w.cell(x, y)[0] in TERRAIN_KINDS | {"deco"}


@pytest.mark.parametrize("seed", range(12))
def test_spawn_has_room_to_roam(seed):
    w = worldgen.World(seed)
    x, y = w.find_open_spot(0, 0)
    assert worldgen.walkable(w.cell(x, y))
    assert w._room_to_roam(x, y, 1500)


def _cave_mouths(world, n):
    found = []
    for y in range(-400, 400, 2):
        for x in range(-400, 400):
            if world.cell(x, y)[0] == "cave":
                found.append((x, y))
                if len(found) == n:
                    return found
    return found


def test_caves_are_fully_connected():
    world = worldgen.World(11)
    mouths = _cave_mouths(world, 4)
    assert mouths, "no caves found near the origin"
    for ex, ey in mouths:
        cave = world.cave(ex, ey)
        open_ = {(x, y) for y in range(cave.H) for x in range(cave.W)
                 if worldgen.walkable(cave.cell(x, y))}
        seen, frontier = {cave.start}, deque([cave.start])
        while frontier:
            x, y = frontier.popleft()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in open_ and n not in seen:
                    seen.add(n)
                    frontier.append(n)
        assert seen == open_
        assert cave.cell(*cave.start)[0] == "cave_exit"


# ---- the game -------------------------------------------------------------------
def test_every_effect_is_safe():
    effects = {o["effect"] for o in worldgen.ODDITIES if o.get("effect")}
    for effect in effects:
        fn = getattr(content, effect) if isinstance(effect, str) else effect
        for companions in (0, explore.MAX_COMPANIONS):
            game = explore.Game(4)
            for i in range(companions):
                game.add_companion("x", "grey", f"pal {i}")
            fn(game)
            ex, ey = _cave_mouths(game.world, 1)[0]
            game.enter_cave(ex, ey)
            fn(game)
            assert worldgen.walkable(game.raw_cell(game.x, game.y))


def test_random_wander_never_crashes():
    random.seed(1)
    game = explore.Game(21)
    moves = list(explore.MOVE_KEYS.values())
    for i in range(3000):
        game.move(*random.choice(moves))
        if i % 500 == 0:
            game.sleep()
    assert game.steps > 500


def test_save_round_trip():
    game = explore.Game(8)
    for _ in range(40):
        game.move(1, 0)
    game.add_companion("d", "yellow", "A duck")
    game.found.add("1,2")
    game.note("saw a thing")
    state = json.loads(json.dumps(game.to_state()))
    again = explore.Game(state["seed"], state)
    assert (again.x, again.y, again.turn) == (game.x, game.y, game.turn)
    assert again.found == game.found and again.journal == game.journal
    assert again.companions == game.companions


def test_postcard_has_the_requested_size():
    lines = explore.postcard_lines(explore.Game(2), 40, 10)
    assert len(lines) == 13
    assert all(len(line) == 42 for line in lines[1:])


class FakeScreen:
    def __init__(self, w, h):
        self.w, self.h = w, h

    def getmaxyx(self):
        return self.h, self.w

    def erase(self):
        pass

    def addstr(self, y, x, text, attr=0):
        assert 0 <= y < self.h and 0 <= x and x + len(text) <= self.w


@pytest.mark.parametrize("size", [(80, 24), (250, 70), (30, 8), (10, 3)])
def test_draw_at_any_size(size):
    game = explore.Game(6)
    screen = FakeScreen(*size)
    no_colors = lambda name: 0  # noqa: E731
    explore.draw(screen, game, no_colors)
    game.pass_time(explore.DAY_LENGTH * 0.7)
    explore.draw(screen, game, no_colors)
    ex, ey = _cave_mouths(game.world, 1)[0]
    game.enter_cave(ex, ey)
    explore.draw(screen, game, no_colors)


def test_structure_oddities_stay_in_their_structure():
    wild = {i for pool in worldgen.ODDITY_POOLS.values() for i in pool}
    assert all(i < len(content.ODDITIES) for i in wild)


def test_runs_always_end():
    game = explore.Game(13)
    for direction in list(explore.RUN_KEYS.values()) * 3:
        explore.run_steps(game, *direction)
    game.pass_time(explore.DAY_LENGTH * 0.7)          # night, with a real map size
    for direction in list(explore.RUN_KEYS.values()) * 3:
        explore.run_steps(game, *direction, 40, (80, 20))
    ex, ey = _cave_mouths(game.world, 1)[0]
    game.enter_cave(ex, ey)
    for direction in list(explore.RUN_KEYS.values()) * 3:
        explore.run_steps(game, *direction, 40, (80, 20))
    assert game.cave_memory[(ex, ey)], "runs should remember what the torch lit"


def test_walking_over_the_cave_exit_does_not_throw_you_out():
    game = explore.Game(13)
    ex, ey = _cave_mouths(game.world, 1)[0]
    game.enter_cave(ex, ey)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        if worldgen.walkable(game.raw_cell(game.x + dx, game.y + dy)):
            break
    assert game.move(dx, dy) and game.move(-dx, -dy)
    assert game.underground and game.raw_cell(game.x, game.y)[0] == "cave_exit"
    game.leave_cave()
    assert not game.underground and (game.x, game.y) == (ex, ey)


def test_a_broken_save_is_set_aside_not_overwritten(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    bad = tmp_path / "world-5.json"
    bad.write_text('{"seed": 5, "x": "not a number"')
    game = explore.load_game(5)
    assert game.seed == 5
    assert (tmp_path / "world-5.json.bad").exists()
    assert "set it aside" in game.messages[-1]
    explore.save_game(game)
    again = explore.load_game()
    assert again.seed == 5 and "set it aside" not in again.messages[-1]


def test_broken_saves_pile_up_instead_of_overwriting(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    save = tmp_path / "world-5.json"
    save.write_text("first broken")
    explore.load_game(5)
    save.write_text("second broken")
    explore.load_game(5)
    assert (tmp_path / "world-5.json.bad").read_text() == "first broken"
    assert (tmp_path / "world-5.json.bad2").read_text() == "second broken"


def test_postcard_peek_leaves_a_broken_save_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    save = tmp_path / "world-5.json"
    save.write_text("{nope")
    assert explore.load_game(5, peek=True).seed == 5
    assert save.exists() and not (tmp_path / "world-5.json.bad").exists()


def test_a_save_for_another_world_is_not_loaded(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    (tmp_path / "world-5.json").write_text(json.dumps({"seed": 7, "x": 0, "y": 0}))
    assert explore.load_game(5).seed == 5


def test_names_get_the_right_article():
    assert explore.a_or_an("abandoned cabin") == "an abandoned cabin"
    assert explore.a_or_an("lighthouse") == "a lighthouse"
