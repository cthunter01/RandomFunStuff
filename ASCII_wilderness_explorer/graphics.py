"""
graphics.py -- how the world looks: plain ASCII, or colored Unicode tiles.

Tiles come from content.TILES: (glyphs, glyph color, ground color), colors as
RGB. They're shown exactly on truecolor terminals and as the nearest of the
256 standard colors elsewhere. Python's curses can only show 255 color pairs
at once, so light and shadow come in a few steps rather than smoothly.
"""

import curses
import locale
import math
import os
from functools import lru_cache

import content
import worldgen

# ASCII look: name -> (256-color index, 8-color fallback, extra attr for 8-color terminals)
PALETTE = {
    "green": (70, curses.COLOR_GREEN, 0),
    "dark_green": (28, curses.COLOR_GREEN, 0),
    "olive": (100, curses.COLOR_YELLOW, 0),
    "blue": (33, curses.COLOR_BLUE, curses.A_BOLD),
    "dark_blue": (25, curses.COLOR_BLUE, 0),
    "cyan": (80, curses.COLOR_CYAN, 0),
    "sand": (180, curses.COLOR_YELLOW, 0),
    "yellow": (220, curses.COLOR_YELLOW, curses.A_BOLD),
    "orange": (208, curses.COLOR_YELLOW, 0),
    "brown": (130, curses.COLOR_RED, 0),
    "red": (160, curses.COLOR_RED, curses.A_BOLD),
    "pink": (211, curses.COLOR_MAGENTA, 0),
    "magenta": (201, curses.COLOR_MAGENTA, curses.A_BOLD),
    "purple": (135, curses.COLOR_MAGENTA, 0),
    "grey": (248, curses.COLOR_WHITE, 0),
    "dark_grey": (240, curses.COLOR_WHITE, curses.A_DIM),
    "white": (231, curses.COLOR_WHITE, curses.A_BOLD),
}
TRIP_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta", "pink"]

TILES = content.TILES
TRUECOLOR = 1 << 24
STEPS = 8                     # light levels 0 (dark) .. STEPS (full daylight)
PLAYER = ("@", (255, 255, 255), (185, 40, 40))
STRUCTURE_PIECES = {"wall", "floor", "door", "rubble", "deco"}   # all stand on the structure's floor
# kinds that are just scenery, so their tile depends only on the cell itself
SCENERY = {k for k, t in TILES.items()
           if t[1] is not None and t[2] is not None and k not in STRUCTURE_PIECES}

# lighting presets: (brightness at level 0, tint color, tint strength)
LIGHTING = {
    "dawn": (0.65, (70, 40, 80), 0.35),
    "dusk": (0.55, (90, 40, 30), 0.35),
    "night": (0.22, (18, 26, 52), 0.7),
    "cave": (0.4, (10, 8, 6), 0.3),     # level 0 underground = cells you remember
}

WALL_STYLES = {   # horizontal, vertical, 4 corners, 4 tees, cross
    "light": "─│┌┐└┘├┤┬┴┼",
    "rounded": "─│╭╮╰╯├┤┬┴┼",
    "double": "═║╔╗╚╝╠╣╦╩╬",
    "heavy": "━┃┏┓┗┛┣┫┳┻╋",
}


# --------------------------------------------------------------------------
# colors
# --------------------------------------------------------------------------
_CUBE = (0, 95, 135, 175, 215, 255)
_BASIC16 = [(0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205),
            (0, 205, 205), (229, 229, 229), (127, 127, 127), (255, 0, 0), (0, 255, 0),
            (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]


def xterm_rgb(index):
    """The RGB value of one of the 256 standard terminal colors."""
    if index < 16:
        return _BASIC16[index]
    if index < 232:
        i = index - 16
        return (_CUBE[i // 36], _CUBE[i // 6 % 6], _CUBE[i % 6])
    v = 8 + 10 * (index - 232)
    return (v, v, v)


def _dist(a, b):
    # weighted so greens (which the eye sees best) count most
    return 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2


@lru_cache(maxsize=4096)
def nearest256(rgb):
    cube = tuple(min(range(6), key=lambda i: abs(_CUBE[i] - v)) for v in rgb)
    best = 16 + 36 * cube[0] + 6 * cube[1] + cube[2]
    grey = 232 + min(23, max(0, round((sum(rgb) / 3 - 8) / 10)))
    return grey if _dist(xterm_rgb(grey), rgb) < _dist(xterm_rgb(best), rgb) else best


@lru_cache(maxsize=1024)
def nearest8(rgb):
    """(basic color, extra attr) for 8-color terminals; bright colors use bold."""
    if rgb in _ASCII8:   # a palette color: same as in the ASCII look
        return _ASCII8[rgb]
    greys = (7, 8, 15)
    pool = [n for n in range(1, 16) if n not in greys] if max(rgb) - min(rgb) > 40 else greys
    i = min(pool, key=lambda n: _dist(_BASIC16[n], rgb))   # never black ink
    if i == 8:   # "bold black" is invisible on many terminals
        return (curses.COLOR_WHITE, 0)
    return (i % 8, curses.A_BOLD if i >= 8 else 0)


def rgb_of(name):
    return xterm_rgb(PALETTE.get(name, PALETTE["white"])[0])


_ASCII8 = {xterm_rgb(c256): (c8, extra) for c256, c8, extra in PALETTE.values()}


def scale(rgb, k):
    return tuple(min(255, int(v * k)) for v in rgb)


# --------------------------------------------------------------------------
# what the terminal can do
# --------------------------------------------------------------------------
def _encoding():
    """The terminal's real character set (Python's UTF-8 mode doesn't change it)."""
    try:
        return locale.nl_langinfo(locale.CODESET)
    except (AttributeError, ValueError):   # Windows
        return getattr(locale, "getencoding", lambda: locale.getpreferredencoding(False))()


def _startup_env():
    """The environment we started with (Python rewrites LC_CTYPE when that locale isn't installed)."""
    try:
        with open("/proc/self/environ", "rb") as f:
            return dict(item.decode("utf-8", "replace").split("=", 1)
                        for item in f.read().split(b"\0") if b"=" in item)
    except OSError:
        return os.environ


def unicode_ok():
    """Tiles need UTF-8 and a full font: not the Linux text console, and not a
    CJK locale (where many of these symbols are drawn double-wide)."""
    enc = (_encoding() or "").lower().replace("-", "").replace("_", "")
    if enc != "utf8" or os.environ.get("TERM", "").startswith("linux"):
        return False
    try:
        lang = locale.getlocale(locale.LC_CTYPE)[0] or ""
    except ValueError:
        lang = ""
    env = _startup_env()
    names = [lang] + [env.get(v, "") for v in ("LC_ALL", "LC_CTYPE", "LANG")]
    return not any(n.lower().startswith(("ja", "zh", "ko")) for n in names)


def _terminfo_exists(name):
    dirs = [os.environ.get("TERMINFO"), os.path.expanduser("~/.terminfo"), "/etc/terminfo",
            "/lib/terminfo", "/usr/share/terminfo", "/usr/lib/terminfo"]
    dirs += (os.environ.get("TERMINFO_DIRS") or "").split(":")
    for d in filter(None, dirs):
        for sub in (name[0], "%02x" % ord(name[0])):
            if os.path.exists(os.path.join(d, sub, name)):
                return True
    return False


def use_truecolor_if_possible():
    """On terminals that say they do truecolor, ask curses for exact colors.
    WILDERNESS_COLORS=256 turns this off; =truecolor forces it."""
    choice = os.environ.get("WILDERNESS_COLORS", "auto").lower()
    term = os.environ.get("TERM", "")
    if choice == "256" or term.endswith("-direct"):
        return
    if choice != "truecolor":
        if os.environ.get("COLORTERM", "").lower() not in ("truecolor", "24bit"):
            return
        if os.environ.get("TMUX") or os.environ.get("STY") or not term.startswith("xterm"):
            return   # multiplexers often don't pass exact colors through
    if _terminfo_exists("xterm-direct"):
        os.environ["TERM"] = "xterm-direct"


class Look:
    """Turns colors into curses attributes and remembers which look is on."""

    def __init__(self, tiles=False, ready=True):
        self.tiles = tiles
        self.depth = 0            # how many colors: 0, 8, 256 or TRUECOLOR
        self._default = -1
        self._pairs = {}
        self._memo = {}
        self._next = 1
        self._max = 0
        if not ready or not curses.has_colors():
            return
        curses.start_color()
        try:
            curses.use_default_colors()
        except curses.error:
            self._default = curses.COLOR_BLACK
        self.depth = TRUECOLOR if curses.COLORS >= TRUECOLOR else 256 if curses.COLORS >= 256 else 8
        self._max = max(0, min(255, curses.COLOR_PAIRS - 1))

    @property
    def grounds(self):
        """Can tiles have colored backgrounds (and so light and shadow)?"""
        return self.tiles and self.depth >= 256

    def new_frame(self):
        # recycle color pairs between frames, keeping half free for the next frame
        if self._next > self._max // 2:
            self._pairs.clear()
            self._memo.clear()
            self._next = 1

    def _pair(self, fg, bg):
        n = self._pairs.get((fg, bg))
        if n is None:
            if self._next > self._max:
                return 0          # out of pairs this frame: default colors
            n = self._next
            try:
                curses.init_pair(n, fg, bg)
            except curses.error:
                return 0
            self._next += 1
            self._pairs[(fg, bg)] = n
        return curses.color_pair(n)

    def _num(self, rgb):
        if self.depth == TRUECOLOR:
            return max(8, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2])   # 0-7 mean palette colors
        return nearest256(rgb)

    def __call__(self, name):
        """ASCII look: the attribute for a palette color name."""
        if not self.depth or name not in PALETTE:
            return 0
        c256, c8, extra = PALETTE[name]
        if self.depth == 8:
            return self._pair(c8, self._default) | extra
        return self._pair(c256 if self.depth == 256 else self._num(xterm_rgb(c256)), self._default)

    def paint(self, ink, ground=None, level=STEPS, light=None):
        """Tiles look: the attribute for RGB ink on an RGB ground, lit to a level."""
        key = (ink, ground, level, light)
        attr = self._memo.get(key)
        if attr is not None:
            return attr
        if not self.depth:
            attr = 0
        elif self.depth == 8 or ground is None:
            c, extra = nearest8(ink) if self.depth == 8 else (self._num(ink), 0)
            attr = self._pair(c, self._default) | extra
        else:
            if light is not None and level < STEPS:
                ink, ground = shade(ink, level, light), shade(ground, level, light)
            attr = self._pair(self._num(ink), self._num(ground))
        if attr or not self.depth:
            self._memo[key] = attr
        return attr


def shade(rgb, level, light):
    base, tint, strength = LIGHTING[light]
    k = level / STEPS
    bright = base + (1 - base) * k
    return tuple(min(255, int(v * bright + t * (1 - k) * strength)) for v, t in zip(rgb, tint))


# --------------------------------------------------------------------------
# tiles
# --------------------------------------------------------------------------
class Light:
    """How lit each spot is right now."""

    def __init__(self, game):
        self.radius = game.sight_radius()
        self.preset = "cave" if game.underground else game.time_of_day()
        if self.preset not in LIGHTING:
            self.preset = None

    def level(self, dist2):
        if self.radius is None:
            return STEPS
        d = math.sqrt(dist2) / self.radius
        return 0 if d >= 1 else max(1, math.ceil((1 - d) * STEPS))


def wall_glyph(is_wall, x, y, style="light"):
    h, v, tl, tr, bl, br, lt, rt, tt, bt, cross = WALL_STYLES.get(style, WALL_STYLES["light"])
    up, down, left, right = is_wall(x, y - 1), is_wall(x, y + 1), is_wall(x - 1, y), is_wall(x + 1, y)
    if up and down:
        return cross if left and right else lt if right else rt if left else v
    if up or down:
        if left and right:
            return bt if up else tt
        if right:
            return bl if up else tl
        if left:
            return br if up else tr
        return v
    return h if left or right else "■"


def natural_ground(game, x, y):
    kind = "cave_floor" if game.underground else game.world.kind(x, y)
    return TILES.get(kind, TILES["meadow"])[2]


def floor_ground(color_name):
    return scale(rgb_of(color_name), 0.3)


_scenery = {}


def tile_parts(game, x, y, cell):
    """(glyph, ink, ground) for a cell you can see."""
    kind = cell[0]
    if kind in SCENERY:
        parts = _scenery.get(cell)
        if parts is None:
            spec = TILES[kind]
            parts = _scenery[cell] = (cell[4], spec[1], spec[2])
        return parts
    spec = TILES.get(kind, (None, None, None))
    glyph = cell[4]
    ink = spec[1] or rgb_of(cell[2])
    ground = spec[2]
    if kind == "wall":
        s = None if game.underground else game.world.structure_at(x, y)
        glyph = wall_glyph(lambda a, b: game.raw_cell(a, b)[0] in ("wall", "door", "rubble"),
                           x, y, (s or {}).get("walls", "light"))
    if ground is None:
        ground = floor_ground(cell[2]) if kind in STRUCTURE_PIECES else natural_ground(game, x, y)
    return glyph, ink, ground


def silhouette(game, x, y, cell):
    """What you make out in the dark: just the lay of the land."""
    if cell[0] in SCENERY and cell[0] not in ("cave", "oddity"):
        return tile_parts(game, x, y, cell)
    kind = game.world.kind(x, y)
    glyphs, ink, ground = TILES.get(kind, TILES["meadow"])
    return glyphs[worldgen.hash2(x, y, game.world.seed, 4) % len(glyphs)], ink, ground


def fancy_glyph(kind, ascii_glyph):
    return (TILES.get(kind) or (ascii_glyph,))[0][0]


# how far each terrain's map color leans from its ground toward its symbol color
MAP_MIX = {"peak": 1.0, "tundra": 0.5, "sand": 0.5, "meadow": 0.55, "woods": 0.4,
           "forest": 0.35, "taiga": 0.35}


@lru_cache(maxsize=64)
def map_rgb(kind):
    """One color per terrain for the pixel map."""
    kind = {"river": "water"}.get(kind, kind)
    glyphs, ink, ground = TILES.get(kind, TILES["meadow"])
    ink = ink or ground or (128, 128, 128)
    ground = ground or ink
    mix = MAP_MIX.get(kind, 0.3)
    return tuple(int(g + (i - g) * mix) for g, i in zip(ground, ink))


def trip_rgb(x, y, turn):
    return rgb_of(TRIP_COLORS[(x + y + turn) % len(TRIP_COLORS)])


def trip_ground(x, y, turn):
    return scale(rgb_of(TRIP_COLORS[(x - y - turn) % len(TRIP_COLORS)]), 0.3)
