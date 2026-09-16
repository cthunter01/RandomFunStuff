#!/usr/bin/env python3
"""
explore.py -- wander an endless ASCII wilderness.

    python3 explore.py                 continue your last wander (or start one)
    python3 explore.py --new           a brand new world
    python3 explore.py --seed 42       a specific world (resumes it if you've been there)
    python3 explore.py --postcard      print a view of the world and exit
    python3 explore.py --mute          no sound this time (M toggles it in the game)
"""

import argparse
import curses
import json
import math
import os
import random
import signal
import sys
import time

import content
import sound
import worldgen

HERE = os.path.dirname(os.path.abspath(__file__))
SAVE_DIR = os.path.join(HERE, "saves")
POSTCARD_DIR = os.path.join(HERE, "postcards")
SOUND_CACHE = os.path.join(HERE, ".cache", "sounds")

DAY_LENGTH = 480            # turns per day
AMBIENT_CHANCE = 0.03       # per step, chance of a flavor message
CHATTER_CHANCE = 0.01       # per step, chance a companion "says" something
MAX_COMPANIONS = 12
METERS_PER_STEP = 10
RUN_STEPS = 60
STEP_SOUNDS = {"water": "splash", "river": "splash", "cave_pool": "splash", "swamp": "splash",
               "tundra": "crunch", "taiga": "crunch"}
FOOTSTEPS = set(STEP_SOUNDS.values()) | {"step"}


# --------------------------------------------------------------------------
# game state & rules (no curses in here)
# --------------------------------------------------------------------------
class Game:
    day_length = DAY_LENGTH

    def __init__(self, seed, state=None):
        self.seed = seed
        self.world = worldgen.World(seed)
        self.turn = DAY_LENGTH // 10
        self.steps = 0
        self.messages = []          # newest last
        self.cues = []              # sounds to play (names in content.SOUNDS); the UI empties it
        self.message_count = 0      # lines ever added (the UI uses it to spot new ones)
        self.said = 0               # say() calls, repeats included
        self.journal = []
        self.found = set()          # keys of discoveries already seen
        self.structures_seen = set()
        self.caves_seen = set()
        self.companions = []        # [{"glyph", "color", "name"}]
        self.trail = []             # where you've just been, newest first
        self.trip_until = 0
        self.cave = None            # the Cave you're in, or None
        self.cave_memory = {}       # entrance -> set of remembered cells
        if state:
            self._load(state)
        else:
            self.x, self.y = self.world.find_open_spot(0, 0)
            self.camp = (self.x, self.y)
            self.say("You wake up in the wilderness. Good day for a wander.")

    # ---- saving ----------------------------------------------------------
    def to_state(self):
        surface = self.cave.entrance if self.cave else (self.x, self.y)
        return {
            "seed": self.seed, "x": surface[0], "y": surface[1],
            "camp": list(self.camp), "turn": self.turn, "steps": self.steps,
            "journal": self.journal, "found": sorted(self.found),
            "structures_seen": sorted(self.structures_seen),
            "caves_seen": sorted(self.caves_seen),
            "companions": self.companions, "messages": self.messages[-5:],
        }

    def _load(self, st):
        # int()/str() everywhere so a hand-edited save fails here, not mid-game
        self.x, self.y = int(st["x"]), int(st["y"])
        cx, cy = st.get("camp", (self.x, self.y))
        self.camp = (int(cx), int(cy))
        if max(map(abs, (self.x, self.y, *self.camp))) > 10**15:
            raise ValueError("coordinates out of range")
        self.turn = int(st.get("turn", self.turn))
        self.steps = int(st.get("steps", 0))
        self.journal = [str(line) for line in st.get("journal", [])]
        self.found = {str(k) for k in st.get("found", [])}
        self.structures_seen = {str(k) for k in st.get("structures_seen", [])}
        self.caves_seen = {str(k) for k in st.get("caves_seen", [])}
        self.companions = [{"glyph": str(c["glyph"])[:1] or "?", "color": str(c.get("color")),
                            "name": str(c["name"])}
                           for c in st.get("companions", [])][:MAX_COMPANIONS]
        self.messages = [str(m) for m in st.get("messages", [])]
        self.say("You pick up where you left off.")

    # ---- the world, as the player sees it --------------------------------
    @property
    def underground(self):
        return self.cave is not None

    def _key(self, x, y):
        if self.cave:
            ex, ey = self.cave.entrance
            return f"{ex},{ey}/{x},{y}"
        return f"{x},{y}"

    def raw_cell(self, x, y):
        return self.cave.cell(x, y) if self.cave else self.world.cell(x, y)

    def cell_at(self, x, y):
        cell = self.raw_cell(x, y)
        if cell[0] == "oddity" and self._key(x, y) in self.found:
            return FOUND_CELL
        return cell

    def where(self):
        if self.cave:
            return self.world.structure_at(*self.cave.entrance), self.cave.entrance
        return self.world.structure_at(self.x, self.y), (self.x, self.y)

    def place_name(self):
        if self.cave:
            return "cave"
        s = self.world.structure_at(self.x, self.y)
        cell = self.raw_cell(self.x, self.y)
        if cell[0] == "oddity" and not s:
            cell = (self.world.kind(self.x, self.y),)   # name the ground, not the '?'
        return worldgen.describe(cell, s)

    @property
    def day(self):
        return self.turn // DAY_LENGTH + 1

    def time_of_day(self):
        t = (self.turn % DAY_LENGTH) / DAY_LENGTH
        if t < 0.06:
            return "dawn"
        if t < 0.50:
            return "daytime"
        if t < 0.58:
            return "dusk"
        return "night"

    def sight_radius(self):
        """How far you can see, or None for 'the whole screen'."""
        if self.cave:
            return 7
        return {"daytime": None, "dawn": 16, "dusk": 16, "night": 10}[self.time_of_day()]

    def tripping(self):
        return self.turn < self.trip_until

    def camp_bearing(self):
        dx = self.where()[1][0] - self.camp[0]
        dy = self.where()[1][1] - self.camp[1]
        dist = math.hypot(dx, dy) * METERS_PER_STEP
        if dist < METERS_PER_STEP:
            return "at camp"
        # direction from camp to you, flipped: which way camp lies
        angle = math.degrees(math.atan2(dx, -dy)) + 180
        compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int((angle + 22.5) // 45) % 8]
        dist_text = f"{dist / 1000:.1f} km" if dist >= 1000 else f"{int(dist)} m"
        return f"camp {dist_text} {compass}"

    # ---- things that happen ----------------------------------------------
    def say(self, text):
        self.said += 1
        if self.messages and self.messages[-1] == text:
            return
        self.message_count += 1
        self.messages.append(text)
        del self.messages[:-50]

    def note(self, text):
        self.journal.append(f"Day {self.day}: {text}")

    def cue(self, name):
        if name not in self.cues:
            self.cues.append(name)

    def move(self, dx, dy):
        nx, ny = self.x + dx, self.y + dy
        cell = self.cell_at(nx, ny)
        if not worldgen.walkable(cell):
            self.say(f"The {worldgen.describe(cell)} blocks your way.")
            self.cue("bump")
            return False
        self.remember([(self.x, self.y), (nx, ny)])   # runs skip redraws; keep the way back
        self.trail.insert(0, (self.x, self.y))
        del self.trail[MAX_COMPANIONS:]
        self.x, self.y = nx, ny
        self.steps += 1
        self.cue(STEP_SOUNDS.get(cell[0], "step"))
        self.tick(cell)
        self.arrive(cell)
        return True

    def tick(self, cell=None):
        before = self.time_of_day()
        self.turn += 1
        now = self.time_of_day()
        if now != before and not self.cave and now in ("dawn", "night"):
            self.cue(now)
        if random.random() < AMBIENT_CHANCE:
            lines = list(content.AMBIENT.get(cell[0] if cell else "", []))
            if not self.cave and self.time_of_day() == "night":
                lines += content.AMBIENT.get("night", [])
            if lines:
                self.say(random.choice(lines))
        if self.companions and random.random() < CHATTER_CHANCE:
            pal = random.choice(self.companions)
            self.say(random.choice(content.COMPANION_CHATTER).replace("{name}", pal["name"]))

    def arrive(self, cell):
        kind = cell[0]
        if kind == "cave" and not self.cave:
            self.enter_cave(self.x, self.y)
        elif kind == "cave_exit" and self.cave:
            self.say("Daylight above. Press < to climb out.")
        elif kind == "oddity":
            self.discover(cell)
        if not self.cave:
            s = self.world.structure_at(self.x, self.y)
            if s:
                sid = "{},{}".format(*s["id"])
                if sid not in self.structures_seen:
                    self.structures_seen.add(sid)
                    self.say(s["text"] or f"You find {a_or_an(s['name'])}.")
                    self.cue("structure")
                    self.note(f"Found {a_or_an(s['name'])} at {self.x}, {self.y}.")

    def discover(self, cell):
        key = self._key(self.x, self.y)
        if key in self.found:
            return
        self.found.add(key)
        odd = worldgen.ODDITIES[cell[3]]
        text = odd.get("text", "Something odd.")
        self.say(text)
        self.cue(odd.get("sound") or "discover")
        where = "in a cave near {}, {}".format(*self.cave.entrance) if self.cave \
            else f"at {self.x}, {self.y}"
        self.note(f"{text} ({where})")
        effect = odd.get("effect")
        if isinstance(effect, str):
            effect = getattr(content, effect, None)
        if callable(effect):
            try:
                effect(self)
            except Exception as err:  # a silly effect should never end the wander
                self.say(f"(Something fizzled: {err})")

    def enter_cave(self, x, y):
        self.cave = self.world.cave(x, y)
        self.x, self.y = self.cave.start
        self.trail = []
        self.say(random.choice(content.ENTER_CAVE))
        self.cue("cave_in")
        if f"{x},{y}" not in self.caves_seen:
            self.caves_seen.add(f"{x},{y}")
            self.note(f"Explored a cave at {x}, {y}.")

    def leave_cave(self):
        self.x, self.y = self.cave.entrance
        self.cave = None
        self.trail = []
        self.cue("cave_out")
        self.say("You climb back out into the " +
                 ("night air." if self.time_of_day() == "night" else "open air."))

    def remember(self, cells):
        if self.cave:
            self.cave_memory.setdefault(self.cave.entrance, set()).update(cells)

    def remembered(self, x, y):
        return self.cave and (x, y) in self.cave_memory.get(self.cave.entrance, ())

    def rest(self):
        self.tick()

    def sleep(self):
        until_dawn = DAY_LENGTH - self.turn % DAY_LENGTH
        self.pass_time(until_dawn)
        self.cue("sleep")
        self.say("You curl up and sleep until dawn. You dream of " + random.choice(content.DREAMS))

    def make_camp(self):
        self.camp = self.where()[1]
        self.cue("camp")
        self.say("You mark this spot as camp.")

    # ---- the API content.py effects use ----------------------------------
    def teleport(self, dx, dy):
        if self.cave:   # leave quietly; the effect says what happened
            self.x, self.y = self.cave.entrance
            self.cave = None
        self.x, self.y = self.world.find_open_spot(self.x + dx, self.y + dy)
        self.trail = []
        self.cue("teleport")

    def pass_time(self, turns):
        self.turn += max(0, int(turns))

    def trip(self, turns):
        self.trip_until = self.turn + int(turns)
        self.cue("trip")

    def add_companion(self, glyph, color, name):
        """Returns False (and says so) if the party is already full."""
        if len(self.companions) >= MAX_COMPANIONS:
            self.say(f"{name} looks at your entourage and decides against it.")
            return False
        self.companions.append({"glyph": str(glyph)[:1] or "?", "color": color, "name": name})
        self.cue("friend")
        return True


def a_or_an(name):
    return ("an " if name[:1].lower() in "aeiou" else "a ") + name


FOUND_CELL = ("found", content.TERRAIN["found"]["glyphs"][0],
              content.TERRAIN["found"]["color"], None)


def save_path(seed):
    return os.path.join(SAVE_DIR, f"world-{seed}.json")


def save_game(game):
    os.makedirs(SAVE_DIR, exist_ok=True)
    tmp = save_path(game.seed) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(game.to_state(), f, indent=1)
    os.replace(tmp, save_path(game.seed))


def load_settings():
    try:
        with open(os.path.join(SAVE_DIR, "settings.json")) as f:
            saved = json.load(f)
        return {"sound": bool(saved.get("sound", True))}
    except (OSError, ValueError, AttributeError):
        return {"sound": True}


def save_settings(settings):
    try:
        os.makedirs(SAVE_DIR, exist_ok=True)
        path = os.path.join(SAVE_DIR, "settings.json")
        with open(path + ".tmp", "w") as f:
            json.dump(settings, f)
        os.replace(path + ".tmp", path)
    except OSError:
        pass   # not being able to remember a preference is no reason to stop


def load_game(seed=None, new=False, peek=False):
    """Resume the requested (or most recent) world, else start fresh.
    peek=True (postcards) never moves a broken save aside."""
    if new:
        return Game(seed if seed is not None else random.randrange(10**6))
    path = None
    if seed is not None:
        path = save_path(seed)
    elif os.path.isdir(SAVE_DIR):
        saves = [os.path.join(SAVE_DIR, f) for f in os.listdir(SAVE_DIR)
                 if f.startswith("world-") and f.endswith(".json")
                 and os.path.isfile(os.path.join(SAVE_DIR, f))]
        if saves:
            path = max(saves, key=os.path.getmtime)
    if path and os.path.exists(path):
        try:
            with open(path) as f:
                state = json.load(f)
            if os.path.basename(save_path(int(state["seed"]))) != os.path.basename(path):
                raise ValueError(f"it is a save for world {state['seed']}")
            return Game(int(state["seed"]), state)
        except Exception as err:
            if peek:
                print(f"(Couldn't read {path}: {err!r})", file=sys.stderr)
                return Game(seed if seed is not None else random.randrange(10**6))
            # never overwrite a save we couldn't read: move it aside and carry on
            bad, n = path + ".bad", 1
            while os.path.lexists(bad):
                n += 1
                bad = f"{path}.bad{n}"
            try:
                os.replace(path, bad)
            except OSError as why:
                sys.exit(f"Couldn't read {path} ({err!r}) or move it aside ({why.strerror}).")
            game = load_game(seed)
            game.say(f"(Couldn't read {os.path.basename(path)} ({err!r}); "
                     f"set it aside as {os.path.basename(bad)})")
            return game
    return Game(seed if seed is not None else random.randrange(10**6))


# --------------------------------------------------------------------------
# drawing
# --------------------------------------------------------------------------
# name: (256-color index, 8-color fallback, extra attr for 8-color terminals)
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
MAP_GLYPH = {k: max(t["glyphs"], key=t["glyphs"].count) for k, t in content.TERRAIN.items()}
MAP_GLYPH.update(woods="t", scrub=";")   # tell same-colored biomes apart on the map


class Colors:
    def __init__(self):
        self.attrs = {}
        if not curses.has_colors():
            return
        curses.start_color()
        try:
            curses.use_default_colors()
            bg = -1
        except curses.error:
            bg = curses.COLOR_BLACK
        rich = 256 <= curses.COLORS < 1 << 24   # truecolor terminals misread 256-color numbers
        for i, (name, (c256, c8, extra)) in enumerate(PALETTE.items(), start=1):
            if i >= curses.COLOR_PAIRS:
                break
            curses.init_pair(i, c256 if rich else c8, bg)
            self.attrs[name] = curses.color_pair(i) | (0 if rich else extra)

    def __call__(self, name):
        return self.attrs.get(name, 0)


def put(scr, y, x, text, attr=0):
    """addstr that never explodes at the screen edges."""
    h, w = scr.getmaxyx()
    if 0 <= y < h and 0 <= x < w:
        try:
            scr.addstr(y, x, text[:w - x], attr)
        except curses.error:
            pass  # writing the bottom-right cell always "fails"; it still draws


MSG_ROWS = 3


def draw(scr, game, colors, fresh=1):
    """fresh = how many of the latest messages are new since the last keypress."""
    scr.erase()
    H, W = scr.getmaxyx()
    if H < 8 or W < 30:
        put(scr, 0, 0, "Embiggen your terminal!", curses.A_BOLD)
        return
    map_h = H - 1 - MSG_ROWS
    left = game.x - W // 2
    top = game.y - map_h // 2
    radius = game.sight_radius()
    fade = (radius * 0.7) ** 2 if radius else None   # the dim outer ring of your torch/night vision
    faded = colors("dark_grey")
    tripping = game.tripping()

    overlay = {}
    for pal, spot in zip(game.companions, game.trail):
        overlay[spot] = (pal["glyph"], colors(pal["color"]) | curses.A_BOLD)
    overlay[(game.x, game.y)] = ("@", curses.A_BOLD | curses.A_REVERSE)

    seen_now = []
    for row in range(map_h):
        wy = top + row
        chunks, run, run_attr, run_x = [], [], None, 0
        for col in range(W):
            wx = left + col
            if (wx, wy) in overlay:
                glyph, attr = overlay[(wx, wy)]
            else:
                dist2 = 0
                if radius is not None:
                    ddx = (wx - game.x) * 0.5   # terminal cells are ~2x taller than wide
                    ddy = wy - game.y
                    dist2 = ddx * ddx + ddy * ddy
                if radius is None or dist2 < radius * radius:
                    cell = game.cell_at(wx, wy)
                    glyph = cell[1]
                    if tripping:
                        attr = colors(TRIP_COLORS[(wx + wy + game.turn) % len(TRIP_COLORS)])
                    elif fade and dist2 >= fade and cell[0] not in ("oddity", "cave", "cave_exit"):
                        attr = faded
                    else:
                        attr = colors(cell[2])
                    if game.underground:
                        seen_now.append((wx, wy))
                elif game.remembered(wx, wy):
                    glyph, attr = game.cell_at(wx, wy)[1], faded
                else:
                    glyph, attr = " ", 0
            if attr != run_attr:
                if run:
                    chunks.append((run_x, "".join(run), run_attr))
                run, run_attr, run_x = [], attr, col
            run.append(glyph)
        if run:
            chunks.append((run_x, "".join(run), run_attr))
        for x, text, attr in chunks:
            put(scr, row + 1, x, text, attr)
    game.remember(seen_now)

    sx, sy = game.where()[1]
    parts = [f" Day {game.day}, {game.time_of_day()}", game.place_name(), game.camp_bearing(),
             f"{sx},{sy}"]
    if game.companions:
        parts.append(f"party of {len(game.companions) + 1}")
    status = " | ".join(parts)
    if len(status) >= W:   # drop the coordinates before anything else
        status = " | ".join(parts[:3] + parts[4:])
    for right in (f"world {game.seed} | ? help ", "? help ", ""):
        if len(status) + len(right) + 3 <= W:
            break
    put(scr, 0, 0, (status.ljust(W - len(right)) + right).ljust(W), curses.A_REVERSE)

    # newest messages at the bottom, wrapped; older ones dimmed
    rows = []
    total = len(game.messages)
    for i in range(total - 1, -1, -1):
        lines = wrap([game.messages[i]], W - 2)
        if rows and len(rows) + len(lines) > MSG_ROWS:
            break
        attr = 0 if total - i <= fresh else curses.A_DIM
        rows[:0] = [(line, attr) for line in lines]
    if len(rows) > MSG_ROWS:   # only a single huge message can overflow
        rows = rows[:MSG_ROWS]
        rows[-1] = (rows[-1][0][:W - 6] + "...", rows[-1][1])
    for r, (line, attr) in enumerate(rows):
        put(scr, H - len(rows) + r, 1, line, attr)


def wrap(lines, width):
    import textwrap
    out = []
    for line in lines:
        out.extend(textwrap.wrap(line, max(10, width), subsequent_indent="  ") or [""])
    return out


def pager(scr, title, lines):
    pos = 0
    while True:
        scr.erase()
        H, W = scr.getmaxyx()
        body = max(1, H - 2)
        text = wrap(lines, W - 3)
        pos = max(0, min(pos, len(text) - body))
        put(scr, 0, 0, f" {title} ".ljust(W), curses.A_REVERSE)
        for i, line in enumerate(text[pos:pos + body]):
            put(scr, i + 1, 1, line)
        put(scr, H - 1, 1, "up/down/PgUp/PgDn scroll, any other key closes", curses.A_DIM)
        scr.refresh()
        k = scr.getch()
        if k in (curses.KEY_UP, ord("k"), ord("w")):
            pos -= 1
        elif k in (curses.KEY_DOWN, ord("j"), ord("s")):
            pos += 1
        elif k == curses.KEY_PPAGE:
            pos -= body
        elif k in (curses.KEY_NPAGE, ord(" ")):
            pos += body
        elif k != curses.KEY_RESIZE:
            if k == 27:
                drain_input(scr)   # don't let the rest of a key sequence leak into the game
            return


def show_map(scr, game, colors):
    zooms = [2, 4, 8, 16]
    zi = 1
    cache = game.world.map_cache
    ox, oy = game.where()[1]
    while True:
        z = zooms[zi]
        H, W = scr.getmaxyx()
        map_h = max(1, H - 2)
        if len(cache) > max(70000, 4 * W * H):
            cache.clear()
        scr.erase()
        put(scr, 0, 0, f" Map: 1 char = {z}x{z * 2} steps | +/- zoom | any other key closes ".ljust(W),
            curses.A_REVERSE)
        put(scr, H - 1, 1, "@ you   X camp", curses.A_DIM)
        cx, cy = ox - ox % z, oy - oy % (z * 2)
        for row in range(map_h):
            chunks, run, run_attr, run_x = [], [], None, 0
            for col in range(W):
                wx = cx + (col - W // 2) * z
                wy = cy + (row - map_h // 2) * z * 2
                kind = cache.get((wx, wy))
                if kind is None:
                    kind = cache[(wx, wy)] = game.world.base_terrain(wx, wy)
                glyph, attr = MAP_GLYPH[kind], colors(content.TERRAIN[kind]["color"])
                if attr != run_attr:
                    if run:
                        chunks.append((run_x, "".join(run), run_attr))
                    run, run_attr, run_x = [], attr, col
                run.append(glyph)
            if run:
                chunks.append((run_x, "".join(run), run_attr))
            for x, text, attr in chunks:
                put(scr, row + 1, x, text, attr)
        camp_col = W // 2 + (game.camp[0] - cx) // z
        camp_row = map_h // 2 + (game.camp[1] - cy) // (z * 2)
        if 0 <= camp_row < map_h:
            put(scr, camp_row + 1, camp_col, "X", colors("red") | curses.A_BOLD)
        put(scr, map_h // 2 + 1 + (oy - cy) // (z * 2), W // 2 + (ox - cx) // z, "@",
            curses.A_BOLD | curses.A_REVERSE)
        scr.refresh()
        k = scr.getch()
        if k in (ord("+"), ord("=")):
            zi = max(0, zi - 1)
        elif k in (ord("-"), ord("_")):
            zi = min(len(zooms) - 1, zi + 1)
        elif k != curses.KEY_RESIZE:
            if k == 27:
                drain_input(scr)
            return


def postcard_lines(game, width=72, height=24):
    left, top = game.x - width // 2, game.y - height // 2
    rows = []
    for j in range(height):
        rows.append("".join("@" if (left + i, top + j) == (game.x, game.y)
                            else game.cell_at(left + i, top + j)[1] for i in range(width)))
    sx, sy = game.where()[1]
    title = f" Greetings from the {game.place_name()}! (world {game.seed}, {sx},{sy}, day {game.day}) "
    border = "+" + "-" * width + "+"
    return [title, border] + ["|" + r + "|" for r in rows] + [border]


def write_postcard(game):
    os.makedirs(POSTCARD_DIR, exist_ok=True)
    sx, sy = game.where()[1]
    path = os.path.join(POSTCARD_DIR, f"world{game.seed}_{sx}_{sy}_day{game.day}_t{game.turn}.txt")
    with open(path, "w") as f:
        f.write("\n".join(postcard_lines(game)) + "\n")
    return os.path.relpath(path, HERE)


# --------------------------------------------------------------------------
# input
# --------------------------------------------------------------------------
UP, DOWN, LEFT, RIGHT = (0, -1), (0, 1), (-1, 0), (1, 0)
MOVE_KEYS = {
    curses.KEY_UP: UP, curses.KEY_DOWN: DOWN, curses.KEY_LEFT: LEFT, curses.KEY_RIGHT: RIGHT,
    ord("w"): UP, ord("s"): DOWN, ord("a"): LEFT, ord("d"): RIGHT,
    ord("k"): UP, ord("j"): DOWN, ord("h"): LEFT, ord("l"): RIGHT,
}
RUN_KEYS = {
    curses.KEY_SR: UP, curses.KEY_SF: DOWN, curses.KEY_SLEFT: LEFT, curses.KEY_SRIGHT: RIGHT,
    ord("W"): UP, ord("S"): DOWN, ord("A"): LEFT, ord("D"): RIGHT,
    ord("K"): UP, ord("J"): DOWN, ord("H"): LEFT, ord("L"): RIGHT,
}

ESC_ARROWS = {"A": UP, "B": DOWN, "C": RIGHT, "D": LEFT}
RUN_STOP_KINDS = {"water", "river", "swamp", "sand", "mountain", "cave",
                  "floor", "door", "deco", "rubble", "oddity", "found"}

def music_mood(game):
    """Which MUSIC loop fits right now."""
    if game.tripping():
        return "trip"
    if game.underground:
        return "cave"
    if game.time_of_day() in ("dusk", "night"):
        return "night"
    if game.world.kind(game.x, game.y) in ("tundra", "taiga"):
        return "snow"
    return "day"


def play_cues(game, audio):
    """Play what the last keypress asked for (a few distinct sounds at most)."""
    names = sorted(game.cues, key=lambda n: n in FOOTSTEPS)[:3]   # footsteps are the first to go
    game.cues.clear()
    if audio:
        for name in names:
            audio.play(name)
        audio.set_mood(music_mood(game))


def toggle_sound(game, audio, settings):
    on = not audio.enabled
    audio.set_enabled(on)
    settings["sound"] = on
    save_settings(settings)
    if not on:
        game.say("Sound off. (M turns it back on.)")
    elif audio.player:
        game.say("Sound on.")
        game.cue("blip")
    else:
        game.say("Sound on, but there's no audio player to play it with "
                 "(pw-play, paplay, aplay, afplay, ffplay or mpv).")


HELP = [
    "Wander. Look at things. That's the game.",
    "",
    "move          arrows, WASD, or hjkl",
    "run           shift + arrow, or W A S D / H J K L in capitals",
    "              (stops at new sights and at edges like shores and rivers)",
    "wait          space or .",
    "sleep         z   (until dawn)",
    "make camp     c   (the status bar points you back to it)",
    "map           m   (+/- to zoom)",
    "notebook      n   (everything you've found)",
    "sound         M   (on/off; remembered for next time)",
    "postcard      p   (saves a postcard of where you are to postcards/)",
    "caves         walk onto an O (or press > while on one) to go in;",
    "              stand on the < and press < to climb out",
    "quit          q   (your wander is saved automatically)",
    "",
    "?  something odd - walk onto it        O  cave mouth",
    "!  something you already found         <  the way out of a cave",
    "#  walls (ruins)                       A  jagged peaks",
    "~  water (dark blue lakes are too deep to wade)",
    "",
    "Want more weirdness? Everything silly lives in content.py.",
]


def interesting_nearby(game):
    return {(game.x + dx, game.y + dy) for dy in range(-2, 3) for dx in range(-2, 3)
            if game.cell_at(game.x + dx, game.y + dy)[0] in ("oddity", "cave", "cave_exit")}


def in_sight(game, view=None):
    """Interesting cells within 2 steps, plus (in the dark) anything lit on the map.
    view = (width, height) of the map area. Runs don't redraw, so this also
    remembers what the torch lit along the way."""
    r = game.sight_radius()
    if r is None or view is None:
        return interesting_nearby(game)
    w, h = view
    lit = [(game.x + dx, game.y + dy)
           for dy in range(max(-r, -(h // 2)), min(r + 1, h - h // 2))
           for dx in range(max(-2 * r, -(w // 2)), min(2 * r + 1, w - w // 2))
           if (dx * 0.5) ** 2 + dy * dy < r * r]
    game.remember(lit)
    return interesting_nearby(game) | {
        p for p in lit if game.cell_at(*p)[0] in ("oddity", "cave", "cave_exit")}


def run_steps(game, dx, dy, steps=RUN_STEPS, view=None):
    seen = in_sight(game, view)
    start = game.raw_cell(game.x, game.y)[0]
    if start in ("cave", "oddity") and not game.underground:
        start = game.world.kind(game.x, game.y)   # the ground under the O or ?
    for _ in range(steps):
        before = (len(game.journal), game.underground, len(game.companions))
        if not game.move(dx, dy):
            return
        if before != (len(game.journal), game.underground, len(game.companions)):
            return
        kind = game.raw_cell(game.x, game.y)[0]
        near = in_sight(game, view)
        if near - seen:
            return
        seen |= near
        if not game.underground and kind != start and kind in RUN_STOP_KINDS:
            return


def run_limit(scr, dx, dy):
    """(steps, map size): don't run further than the screen shows, so nothing
    slips by unseen."""
    H, W = scr.getmaxyx()
    steps = max(1, min(RUN_STEPS, (H - 2 - MSG_ROWS) // 2 if dy else W // 2 - 1))
    return steps, (W, H - 1 - MSG_ROWS)


def drain_input(scr):
    """Read the rest of ONE escape sequence curses didn't recognise (after ESC)."""
    seq = ""
    try:
        while True:
            unfinished = seq[:1] in ("[", "O") and not (len(seq) > 1 and "@" <= seq[-1] <= "~")
            scr.timeout(500 if unfinished else 0)   # a split sequence gets a moment to arrive
            c = scr.getch()
            if c == -1:
                break
            if not 0 <= c < 256:
                curses.ungetch(c)   # a real key; leave it for the main loop
                break
            seq += chr(c)
            if seq[0] == "[":
                if len(seq) > 1 and "@" <= seq[-1] <= "~":
                    break           # end of a CSI sequence like [1;2A
            elif seq[0] != "O" or len(seq) == 2:
                break               # Alt+key, or an SS3 key like O A
    finally:
        scr.timeout(-1)
    return seq


def play(scr, game, audio=None, settings=None):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    scr.keypad(True)
    colors = Colors()
    last_save = time.monotonic()
    fresh = 1
    reported = None
    settings = settings if settings is not None else {"sound": True}
    try:
        while True:
            play_cues(game, audio)
            if audio and audio.enabled and audio.problem != reported:
                reported = audio.problem   # back to None once M clears it, so new trouble is told
                if reported:
                    game.say(reported)
                    fresh = 1
            draw(scr, game, colors, fresh)
            scr.refresh()
            k = scr.getch()
            said, added, turn = game.said, game.message_count, game.turn
            if k in MOVE_KEYS:
                game.move(*MOVE_KEYS[k])
            elif k in RUN_KEYS:
                run_steps(game, *RUN_KEYS[k], *run_limit(scr, *RUN_KEYS[k]))
            elif k == 27:
                # Esc, Alt+key, or e.g. shift+arrow in terminals curses doesn't fully know
                seq = drain_input(scr)
                arrow = ESC_ARROWS.get(seq[-1:]) if seq[:1] in ("[", "O") else None
                if arrow and ";2" in seq:
                    run_steps(game, *arrow, *run_limit(scr, *arrow))
                elif arrow:
                    game.move(*arrow)
            elif k == ord("q"):
                return
            elif k == ord("<"):
                if game.underground and game.raw_cell(game.x, game.y)[0] == "cave_exit":
                    game.leave_cave()
                    game.tick()
                else:
                    game.say("Find the < and stand on it to climb out." if game.underground
                             else "There's nowhere to climb out of.")
            elif k == ord(">"):
                if not game.underground and game.raw_cell(game.x, game.y)[0] == "cave":
                    game.enter_cave(game.x, game.y)
                    game.tick()
                else:
                    game.say("You're already as far down as this cave goes." if game.underground
                             else "There's no way down here. Find an O.")
            elif k in (ord(" "), ord(".")):
                game.rest()
            elif k == ord("z"):
                game.sleep()
            elif k == ord("c"):
                game.make_camp()
            elif k == ord("m"):
                show_map(scr, game, colors)
            elif k == ord("n"):
                n = len(game.journal)
                pager(scr, f"Notebook ({n} entr{'y' if n == 1 else 'ies'}, newest first)",
                      list(reversed(game.journal)) or ["Nothing yet. Go look at things."])
            elif k == ord("M") and audio:
                toggle_sound(game, audio, settings)
            elif k == ord("p"):
                try:
                    game.say(f"Postcard saved to {write_postcard(game)}")
                    game.cue("camera")
                except OSError as err:
                    game.say(f"The postcard blew away ({err.strerror}).")
            elif k == ord("?"):
                pager(scr, "Help", HELP)
            if game.said != said or game.turn != turn:
                fresh = max(game.message_count - added, int(game.said != said))
            if time.monotonic() - last_save > 30:
                save_game(game)
                last_save = time.monotonic()
    except KeyboardInterrupt:
        return


def main(argv=None):
    ap = argparse.ArgumentParser(description="Wander an endless ASCII wilderness.")
    ap.add_argument("--seed", type=int, help="which world to visit")
    ap.add_argument("--new", action="store_true", help="start over (a random world unless --seed)")
    ap.add_argument("--postcard", action="store_true", help="print a view of the world and exit")
    ap.add_argument("--at", metavar="X,Y", help="with --postcard: where to look")
    ap.add_argument("--size", default="72x24", metavar="WxH", help="with --postcard: view size")
    ap.add_argument("--mute", action="store_true", help="no sound this time (M toggles it in the game)")
    args = ap.parse_args(argv)

    if args.postcard:
        game = load_game(args.seed, args.new, peek=True)
        try:
            if args.at:
                game.x, game.y = (int(v) for v in args.at.split(","))
                game.cave = None
            width, height = (int(v) for v in args.size.lower().split("x"))
        except ValueError:
            ap.error("--at wants X,Y and --size wants WIDTHxHEIGHT, e.g. --at 10,-40 --size 80x30")
        if not (0 < width <= 1000 and 0 < height <= 1000) or max(abs(game.x), abs(game.y)) > 10**15:
            ap.error("--size goes up to 1000x1000 and --at up to 10**15 in each direction")
        print("\n".join(postcard_lines(game, width, height)))
        return 0

    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print("This needs a real terminal. (Try --postcard for a non-interactive peek.)")
        return 1
    try:
        curses.setupterm()
    except curses.error:
        print(f"curses doesn't know this terminal (TERM={os.environ.get('TERM')}). "
              "Try: TERM=xterm-256color python3 explore.py")
        return 1
    game = load_game(args.seed, args.new)
    os.environ.setdefault("ESCDELAY", "25")

    signals = [getattr(signal, n) for n in ("SIGHUP", "SIGTERM") if hasattr(signal, n)]

    def quit_now(*_):   # closing the terminal still saves; ignore the follow-up hangups
        for sig in signals:
            signal.signal(sig, signal.SIG_IGN)
        sys.exit(0)

    for sig in signals:
        signal.signal(sig, quit_now)
    settings = load_settings()
    audio = sound.Sound(content.SOUNDS, content.MUSIC, SOUND_CACHE,
                        enabled=settings["sound"] and not args.mute)
    try:
        curses.wrapper(play, game, audio, settings)
    finally:
        try:
            save_game(game)
        finally:
            audio.close()
    print(f"You walked {game.steps} steps over {game.day} day(s) and found "
          f"{len(game.found)} odd thing(s). World {game.seed} is saved; "
          f"run explore.py again to keep wandering.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
