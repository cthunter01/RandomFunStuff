"""
Checks for the colored tile look. Run with:  python3 -m pytest -q
"""

import unicodedata

import pytest

import content
import explore
import graphics
import worldgen


def single_width(ch):
    """One terminal cell. (Emoji are marked "W"ide in Unicode's width data.)"""
    return (unicodedata.east_asian_width(ch) not in "WF" and not unicodedata.combining(ch)
            and unicodedata.category(ch) not in ("Cc", "Cf", "Mn", "Me"))


# ---- the TILES table ------------------------------------------------------------
def test_every_terrain_has_a_tile():
    missing = set(content.TERRAIN) - set(content.TILES)
    assert not missing, f"add these to content.TILES: {sorted(missing)}"


@pytest.mark.parametrize("kind", sorted(content.TILES))
def test_tiles_are_well_formed(kind):
    glyphs, ink, ground = content.TILES[kind]
    assert glyphs, "needs at least one symbol"
    for ch in glyphs:
        assert ch == " " or single_width(ch), \
            f"{ch!r} may be two cells wide or invisible; pick another symbol"
    for rgb in (ink, ground):
        if rgb is not None:
            assert isinstance(rgb, tuple) and len(rgb) == 3 and \
                all(isinstance(v, int) and 0 <= v <= 255 for v in rgb), \
                f"bad color {rgb!r}: use (red, green, blue) with whole numbers 0-255"
    if kind not in ("wall", "rubble", "door", "floor", "crystal", "mushrooms", "oddity", "found"):
        assert ink is not None and ground is not None, "scenery needs both colors"


def test_structure_wall_styles_exist():
    for spec in content.STRUCTURES:
        assert spec.get("walls", "light") in graphics.WALL_STYLES, \
            f"{spec['name']}: walls must be one of {sorted(graphics.WALL_STYLES)}"


# ---- colors ---------------------------------------------------------------------
def test_nearest_256_color_is_exact_for_palette_colors():
    for index in list(range(16, 256, 7)):
        assert graphics.xterm_rgb(graphics.nearest256(graphics.xterm_rgb(index))) == \
            graphics.xterm_rgb(index)


def test_eight_color_tiles_keep_the_ascii_colors_for_structures():
    for name, (c256, c8, extra) in graphics.PALETTE.items():
        assert graphics.nearest8(graphics.rgb_of(name)) == (c8, extra), name


def test_eight_color_terminals_never_get_black_symbols():
    for kind, (glyphs, ink, ground) in content.TILES.items():
        if ink:
            assert graphics.nearest8(ink)[0] != graphics.curses.COLOR_BLACK, kind


def test_remembered_cave_cells_stay_visible():
    wall, floor = content.TILES["cave_wall"], content.TILES["cave_floor"]
    ink = graphics.nearest256(graphics.shade(wall[1], 0, "cave"))
    assert ink not in {graphics.nearest256(graphics.shade(wall[2], 0, "cave")),
                       graphics.nearest256(graphics.shade(floor[2], 0, "cave"))}


def test_no_color_terminal_gets_plain_attributes():
    look = graphics.Look(tiles=True, ready=False)
    assert look.paint((1, 2, 3), (4, 5, 6), 2, "night") == 0
    assert look("green") == 0
    assert not look.grounds


class CountingLook(graphics.Look):
    """A Look that pretends to have colors and counts the pairs a frame needs."""

    def __init__(self, depth):
        super().__init__(tiles=True, ready=False)
        self.depth, self._max = depth, 255
        self.frames = []

    def new_frame(self):
        self._pairs, self._memo, self._next = {}, {}, 1
        self.frames.append(self._pairs)

    def _pair(self, fg, bg):
        n = self._pairs.setdefault((fg, bg), len(self._pairs) + 1)
        return n << 8


class FakeScreen:
    def __init__(self, w, h):
        self.w, self.h = w, h

    def getmaxyx(self):
        return self.h, self.w

    def erase(self):
        pass

    def addstr(self, y, x, text, attr=0):
        assert 0 <= y < self.h and 0 <= x and x + len(text) <= self.w


def _cave_mouth(world):
    for y in range(-300, 300, 2):
        for x in range(-300, 300):
            if world.cell(x, y)[0] == "cave":
                return x, y
    raise AssertionError("no cave nearby")


@pytest.mark.parametrize("depth", [256, graphics.TRUECOLOR], ids=["256", "truecolor"])
@pytest.mark.parametrize("seed", [1, 7, 42])
def test_a_frame_never_needs_more_than_255_color_pairs(seed, depth):
    game = explore.Game(seed)
    for _ in range(3):
        game.add_companion("d", "yellow", "duck")
    look, screen = CountingLook(depth), FakeScreen(250, 70)
    for turns in (0, 0.45, 0.2, 0.3):          # day, dusk, night, dawn
        game.pass_time(explore.DAY_LENGTH * turns)
        explore.draw(screen, game, look)
    game.trip(20)
    explore.draw(screen, game, look)
    game.trip_until = 0
    game.enter_cave(*_cave_mouth(game.world))
    for dx in (1, 1, 1):
        game.move(dx, 0)
    explore.draw(screen, game, look)
    worst = max(len(f) for f in look.frames)
    # new_frame keeps half of the 255 pairs free, so a frame must fit in that half
    assert worst <= 255 - 255 // 2, f"a frame needed {worst} color pairs; only 128 are sure to be free"


def test_running_out_of_color_pairs_falls_back_quietly(monkeypatch):
    made = []
    monkeypatch.setattr(graphics.curses, "init_pair", lambda n, f, b: made.append(n))
    monkeypatch.setattr(graphics.curses, "color_pair", lambda n: n << 8)
    look = graphics.Look(tiles=True, ready=False)
    look.depth, look._max = 256, 3
    attrs = [look.paint((v, 0, 0), (0, 0, v)) for v in (10, 90, 170, 250)]
    assert attrs[:3] == [256, 512, 768] and attrs[3] == 0
    look.new_frame()
    assert look.paint((0, 200, 0), (0, 0, 0)) == 256   # pair numbers are reused next frame


# ---- tiles & drawing --------------------------------------------------------------
def test_walls_join_up():
    walls = {(0, 0), (1, 0), (2, 0), (0, 1), (2, 1), (0, 2), (1, 2), (2, 2), (1, 3)}
    def is_wall(x, y):
        return (x, y) in walls
    glyphs = {p: graphics.wall_glyph(is_wall, *p, "double") for p in walls}
    assert glyphs[(0, 0)] == "╔" and glyphs[(2, 0)] == "╗" and glyphs[(1, 0)] == "═"
    assert glyphs[(0, 1)] == "║" and glyphs[(1, 2)] == "╦" and glyphs[(1, 3)] == "║"
    assert graphics.wall_glyph(lambda x, y: False, 0, 0) == "■"


def test_tile_glyphs_are_stable_in_the_dark():
    game = explore.Game(3)
    for x in range(-40, 40):
        cell = game.raw_cell(x, 5)
        if cell[0] in graphics.SCENERY and cell[0] not in ("cave", "oddity"):
            assert graphics.silhouette(game, x, 5, cell)[0] == cell[4]


def test_structures_get_joined_walls_in_postcards():
    world = worldgen.World(7)
    for rx in range(-10, 10):
        s = world.structure(rx, 0)
        if s and any(c[0] == "wall" for c in s["cells"].values()):
            break
    game = explore.Game(7)
    game.x, game.y = s["x0"], s["y0"]
    tiles = explore.postcard_lines(game, 40, 12, tiles=True)
    plain = explore.postcard_lines(game, 40, 12)
    assert len(tiles) == len(plain) and all(len(a) == len(b) for a, b in zip(tiles, plain))
    assert "#" in "".join(plain) and any(ch in "".join(tiles) for ch in "─═━│║┃")


def test_help_legend_lines_up_in_both_looks():
    for tiles in (False, True):
        lines = explore.help_lines(graphics.Look(tiles=tiles, ready=False))
        columns = {line.index(label) for line in lines
                   for label in ("cave mouth", "the way out", "jagged peaks") if label in line}
        assert len(columns) == 1


def test_map_has_a_color_for_every_terrain():
    world = worldgen.World(2)
    kinds = {world.base_terrain(x, y) for x in range(-3000, 3000, 37) for y in range(-3000, 3000, 41)}
    for kind in kinds | set(content.TERRAIN):
        assert len(graphics.map_rgb(kind)) == 3


# ---- choosing the look ------------------------------------------------------------
def test_tiles_need_utf8(monkeypatch):
    for var in ("LC_ALL", "LC_CTYPE", "LANG"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setattr(graphics, "_startup_env", lambda: graphics.os.environ)
    # LC_ALL=C: Python's UTF-8 mode says utf-8, but the terminal's character set is ASCII
    monkeypatch.setattr(graphics.locale, "getpreferredencoding", lambda *a: "utf-8")
    monkeypatch.setattr(graphics.locale, "nl_langinfo", lambda item: "ANSI_X3.4-1968", raising=False)
    monkeypatch.setattr(graphics.locale, "getencoding", lambda: "ANSI_X3.4-1968", raising=False)
    assert not graphics.unicode_ok()
    monkeypatch.setattr(graphics, "_encoding", lambda: "UTF-8")
    monkeypatch.setenv("TERM", "linux")
    assert not graphics.unicode_ok()
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setattr(graphics.locale, "getlocale", lambda category=None: ("ja_JP", "UTF-8"))
    assert not graphics.unicode_ok()
    monkeypatch.setattr(graphics.locale, "getlocale", lambda category=None: ("en_US", "UTF-8"))
    assert graphics.unicode_ok()


@pytest.mark.parametrize("env, expect", [
    ({"TERM": "xterm-256color", "COLORTERM": "truecolor"}, "xterm-direct"),
    ({"TERM": "xterm-256color"}, "xterm-256color"),
    ({"TERM": "xterm-256color", "COLORTERM": "truecolor", "TMUX": "1"}, "xterm-256color"),
    ({"TERM": "screen-256color", "COLORTERM": "truecolor"}, "screen-256color"),
    ({"TERM": "xterm-256color", "COLORTERM": "truecolor", "WILDERNESS_COLORS": "256"}, "xterm-256color"),
])
def test_truecolor_is_used_only_when_safe(monkeypatch, env, expect):
    for name in ("TERM", "COLORTERM", "TMUX", "STY", "WILDERNESS_COLORS"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(graphics, "_terminfo_exists", lambda name: True)
    graphics.use_truecolor_if_possible()
    assert graphics.os.environ["TERM"] == expect


def test_graphics_setting_is_remembered(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    settings = explore.load_settings()
    assert settings["graphics"] == "tiles"
    game, look = explore.Game(3), graphics.Look(tiles=True, ready=False)
    explore.toggle_graphics(game, look, settings)
    assert not look.tiles and explore.load_settings()["graphics"] == "ascii"
    monkeypatch.setattr(graphics, "unicode_ok", lambda: False)
    explore.toggle_graphics(game, look, settings)
    assert not look.tiles and "UTF-8" in game.messages[-1]
