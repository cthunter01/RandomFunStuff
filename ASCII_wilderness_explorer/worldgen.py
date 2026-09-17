"""
worldgen.py -- deterministic, endless world generation.

The same seed always makes the same world. Nothing here knows about the
screen or the player; it just answers "what is at (x, y)?".

A cell is a tuple: (kind, glyph, color, oddity_index, tile_glyph)
  kind          -- a key of content.TERRAIN, or "deco" for structure decoration
  glyph, color  -- how it looks in plain ASCII
  oddity_index  -- index into ODDITIES for '?' cells, otherwise None
  tile_glyph    -- how it looks in the colored look (content.TILES)
"""

import math
import random
from collections import OrderedDict, deque
from functools import lru_cache

import content

CHUNK_BITS = 5
CHUNK = 1 << CHUNK_BITS          # cells are generated and cached in 32x32 chunks
CHUNK_CACHE = 1024
CLIMATE_STEP = 4                 # climate is sampled every 4 cells and blended (fast!)
REGION = 48                      # at most one structure per 48x48 region
STRUCTURE_CHANCE = 0.53
CAVE_CHANCE = 0.002              # per hills/mountain cell
ODDITY_CHANCE = 0.0004           # per land cell -- raise it if you want more '?'
BAD_GROUND = {"deep_water", "water", "river", "peak"}   # no building here

MASK = 0xFFFFFFFF


# --------------------------------------------------------------------------
# hashing & noise
# --------------------------------------------------------------------------
def _mix(h):
    h ^= h >> 16
    h = (h * 0x7FEB352D) & MASK
    h ^= h >> 15
    h = (h * 0x846CA68B) & MASK
    h ^= h >> 16
    return h


def hash2(x, y, seed, salt=0):
    """A well-mixed 32-bit hash of an integer coordinate."""
    h = _mix((seed * 0x9E3779B1 + salt * 0x85EBCA77) & MASK)
    h = _mix((h + x * 0x27D4EB2D) & MASK)
    return _mix((h + y * 0x165667B1) & MASK)


def rand01(x, y, seed, salt=0):
    return hash2(x, y, seed, salt) / 4294967296.0


@lru_cache(maxsize=1 << 13)
def _lattice(ix, iy, seed, salt):
    return rand01(ix, iy, seed, salt)


def value_noise(x, y, seed, salt):
    x0 = math.floor(x)
    y0 = math.floor(y)
    tx = x - x0
    ty = y - y0
    tx = tx * tx * (3 - 2 * tx)
    ty = ty * ty * (3 - 2 * ty)
    a = _lattice(x0, y0, seed, salt)
    b = _lattice(x0 + 1, y0, seed, salt)
    c = _lattice(x0, y0 + 1, seed, salt)
    d = _lattice(x0 + 1, y0 + 1, seed, salt)
    top = a + (b - a) * tx
    bot = c + (d - c) * tx
    return top + (bot - top) * ty


# each octave is rotated differently, which hides value noise's square-ish grid
_ROTATIONS = [(math.cos(0.6 + 1.1 * i), math.sin(0.6 + 1.1 * i)) for i in range(8)]


def fbm(x, y, seed, salt, scale, octaves):
    """Fractal noise in roughly [0, 1], clustered around 0.5."""
    total = norm = 0.0
    amp = 1.0
    f = 1.0 / scale
    for i in range(octaves):
        c, s = _ROTATIONS[i]
        total += amp * value_noise((x * c - y * s) * f, (x * s + y * c) * f, seed, salt * 16 + i)
        norm += amp
        amp *= 0.5
        f *= 2.0
    return total / norm


# --------------------------------------------------------------------------
# content tables, prepared once
# --------------------------------------------------------------------------
TERRAIN = content.TERRAIN
WALKABLE = {k for k, t in TERRAIN.items() if t["walk"]} | {"deco"}


def _odd(entry):
    """Be forgiving: a bare string is a discovery, "biomes" may be one string."""
    odd = dict(entry) if isinstance(entry, dict) else {"text": str(entry)}
    if isinstance(odd.get("biomes"), str):
        odd["biomes"] = {odd["biomes"]}
    return odd


# Every discovery the world can place; structure-specific ones get appended.
ODDITIES = [_odd(o) for o in content.ODDITIES]


def _oddity_pools():
    pools = {}
    for i, odd in enumerate(ODDITIES[:len(content.ODDITIES)]):
        for biome in odd.get("biomes") or content.LAND:
            pools.setdefault(biome, []).append(i)
    return pools


def _parse_art(art):
    lines = art.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _prepare_structures():
    prepared = []
    for spec in content.STRUCTURES:
        rows = _parse_art(spec["art"])
        w = max((len(r) for r in rows), default=0)
        h = len(rows)
        if not w or max(w, h) > REGION - 4:
            continue  # empty or too big to fit in a region; skip it quietly
        own = []
        for odd in spec.get("oddities", []):
            ODDITIES.append(_odd(odd))
            own.append(len(ODDITIES) - 1)
        prepared.append({"spec": spec, "rows": rows, "w": w, "h": h, "own": own})
    return prepared


STRUCTURES = _prepare_structures()
ODDITY_POOLS = _oddity_pools()


def walkable(cell):
    return cell[0] in WALKABLE


def describe(cell, structure=None):
    """Human name for a cell."""
    kind = cell[0]
    if kind in ("deco", "floor", "door", "wall", "rubble", "oddity") and structure:
        return structure["name"]
    return TERRAIN.get(kind, {}).get("name", kind)


# --------------------------------------------------------------------------
# the overworld
# --------------------------------------------------------------------------
class World:
    def __init__(self, seed):
        self.seed = seed
        self._chunks = OrderedDict()
        self._kind_cache = OrderedDict()
        self._intern = {}
        self._structures = {}
        self._caves = OrderedDict()
        self.map_cache = {}         # the map view's samples, (x, y) -> kind

    # ---- raw terrain -----------------------------------------------------
    def climate(self, x, y):
        """Return (elevation, moisture, temperature, river) at a point."""
        s = self.seed
        # gently warp the coordinates so coastlines aren't too blobby
        wx = x + 24.0 * (fbm(x, y, s, 1, 80.0, 2) - 0.5)
        wy = y + 24.0 * (fbm(x + 500, y - 500, s, 1, 80.0, 2) - 0.5)
        elev = fbm(wx, wy, s, 2, 110.0, 5)
        moist = fbm(wx, wy, s, 3, 90.0, 3)
        temp = fbm(x, y, s, 4, 400.0, 2)
        river = fbm(wx, wy, s, 5, 160.0, 3)
        return elev, moist, temp, river

    def base_terrain(self, x, y):
        """Exact terrain at a point (the map uses this)."""
        return self.classify(x, y, *self.climate(x, y))

    def classify(self, x, y, e, m, t, r):
        # thresholds are tuned to the noise's actual spread (it hugs 0.5)
        cold = t < 0.30
        if e < 0.335:
            return "deep_water"
        if e < 0.365:
            return "water"
        if e < 0.61 and abs(r - 0.5) < 0.006:
            return "river"
        if e < 0.385:
            return "tundra" if cold else "sand"
        if e > 0.735:
            # break big massifs up with passes, fewer the higher you go
            if fbm(x, y, self.seed, 6, 14.0, 2) < 0.5 - (e - 0.735) * 1.5:
                return "mountain"
            return "peak"
        if e > 0.67:
            return "mountain"
        if e > 0.61:
            return "hills"
        if cold:
            return "taiga" if m > 0.5 else "tundra"
        if m > 0.69 and e < 0.43:
            return "swamp"
        if m > 0.58:
            return "forest"
        if m > 0.48:
            return "woods"
        if t > 0.63 and m < 0.40:
            return "scrub"
        return "meadow"

    def _kinds(self, cx, cy):
        """Terrain kinds for a chunk, from climate sampled on a coarse grid."""
        key = (cx, cy)
        kinds = self._kind_cache.get(key)
        if kinds is not None:
            return kinds
        step = CLIMATE_STEP
        x0, y0 = cx * CHUNK, cy * CHUNK
        n = CHUNK // step + 1
        grid = [[self.climate(x0 + i * step, y0 + j * step) for i in range(n)]
                for j in range(n)]
        kinds = []
        for y in range(CHUNK):
            j, fy = divmod(y, step)
            fy /= step
            for x in range(CHUNK):
                i, fx = divmod(x, step)
                fx /= step
                a, b = grid[j][i], grid[j][i + 1]
                c, d = grid[j + 1][i], grid[j + 1][i + 1]
                w00, w10 = (1 - fx) * (1 - fy), fx * (1 - fy)
                w01, w11 = (1 - fx) * fy, fx * fy
                kinds.append(self.classify(
                    x0 + x, y0 + y,
                    *(a[k] * w00 + b[k] * w10 + c[k] * w01 + d[k] * w11 for k in range(4))))
        self._kind_cache[key] = kinds
        if len(self._kind_cache) > CHUNK_CACHE:
            self._kind_cache.popitem(last=False)
        return kinds

    def kind(self, x, y):
        """Natural terrain kind at a point, as the walkable world has it."""
        kinds = self._kinds(x >> CHUNK_BITS, y >> CHUNK_BITS)
        return kinds[((y & (CHUNK - 1)) << CHUNK_BITS) | (x & (CHUNK - 1))]

    def _make(self, kind, x, y, color=None, glyph=None, oddity=None):
        if glyph is None:
            glyphs = TERRAIN[kind]["glyphs"]
            glyph = glyphs[hash2(x, y, self.seed, 3) % len(glyphs)]
            fancy = content.TILES.get(kind, (glyphs,))[0]
            fancy = fancy[hash2(x, y, self.seed, 4) % len(fancy)]
        else:
            fancy = glyph
        cell = (kind, glyph, color or TERRAIN[kind]["color"], oddity, fancy)
        return self._intern.setdefault(cell, cell)

    def _natural_cell(self, x, y, kind):
        if kind in ("hills", "mountain") and rand01(x, y, self.seed, 11) < CAVE_CHANCE \
                and not self.structure_at(x, y):
            return self._make("cave", x, y)
        if kind in content.LAND and rand01(x, y, self.seed, 12) < ODDITY_CHANCE \
                and not self.structure_at(x, y):
            pool = ODDITY_POOLS.get(kind)
            if pool:
                pick = pool[hash2(x, y, self.seed, 13) % len(pool)]
                return self._make("oddity", x, y, oddity=pick)
        return self._make(kind, x, y)

    # ---- structures ------------------------------------------------------
    def structure(self, rx, ry):
        """The structure in region (rx, ry), or None. Cached."""
        key = (rx, ry)
        if key in self._structures:
            return self._structures[key]
        result = None
        s = self.seed
        if STRUCTURES and rand01(rx, ry, s, 20) < STRUCTURE_CHANCE:
            # pick an anchor, then a structure that suits the ground there
            ax = rx * REGION + REGION // 2 + int((rand01(rx, ry, s, 21) - 0.5) * (REGION // 2))
            ay = ry * REGION + REGION // 2 + int((rand01(rx, ry, s, 22) - 0.5) * (REGION // 2))
            biome = self.kind(ax, ay)
            fits = [p for p in STRUCTURES if biome in p["spec"]["biomes"]]
            if fits:
                p = fits[hash2(rx, ry, s, 23) % len(fits)]
                result = self._build_structure(p, ax, ay, biome, rx, ry)
        if len(self._structures) > 8192:
            self._structures.clear()
        self._structures[key] = result
        return result

    def _build_structure(self, p, ax, ay, biome, rx, ry):
        spec = p["spec"]
        color = spec.get("color", "brown")
        decay = spec.get("decay", 0.0)
        # keep the whole thing inside its own region so chunks stamp it fully
        left, top = rx * REGION + 1, ry * REGION + 1
        x0 = min(max(ax - p["w"] // 2, left), left + REGION - 2 - p["w"])
        y0 = min(max(ay - p["h"] // 2, top), top + REGION - 2 - p["h"])
        # don't build in lakes or rivers, or up against a sheer peak
        bad = BAD_GROUND - {"water"} if biome == "sand" else BAD_GROUND   # shore things may paddle
        for y in range(y0 - 1, y0 + p["h"] + 1):
            for x in range(x0 - 1, x0 + p["w"] + 1):
                if self.kind(x, y) in bad:
                    return None
        pool = p["own"] or ODDITY_POOLS.get(biome) or []
        cells = {}
        for j, row in enumerate(p["rows"]):
            for i, ch in enumerate(row):
                if ch == " ":
                    continue
                x, y = x0 + i, y0 + j
                if ch == "#":
                    kind = "rubble" if rand01(x, y, self.seed, 24) < decay else "wall"
                    cell = self._make(kind, x, y, color=color)
                elif ch == ".":
                    cell = self._make("floor", x, y, color=color)
                elif ch == "+":
                    cell = self._make("door", x, y, color=color)
                elif ch == "?" and pool:
                    pick = pool[hash2(x, y, self.seed, 25) % len(pool)]
                    cell = self._make("oddity", x, y, oddity=pick)
                elif ch == "?":
                    cell = self._make("floor", x, y, color=color)
                elif ch == "`":
                    cell = self._make("deco", x, y, color=color, glyph=" ")
                else:
                    cell = self._make("deco", x, y, color=color, glyph=ch)
                cells[(x, y)] = cell
        return {"name": spec["name"], "text": spec.get("text", ""), "id": (x0, y0),
                "walls": spec.get("walls", "light"),
                "x0": x0, "y0": y0, "x1": x0 + p["w"], "y1": y0 + p["h"], "cells": cells}

    def structure_at(self, x, y):
        s = self.structure(x // REGION, y // REGION)
        if s and s["x0"] <= x < s["x1"] and s["y0"] <= y < s["y1"]:
            return s
        return None

    # ---- chunks ----------------------------------------------------------
    def _chunk(self, cx, cy):
        key = (cx, cy)
        chunk = self._chunks.get(key)
        if chunk is not None:
            self._chunks.move_to_end(key)
            return chunk
        x0, y0 = cx * CHUNK, cy * CHUNK
        kinds = self._kinds(cx, cy)
        chunk = [self._natural_cell(x0 + i, y0 + j, kinds[(j << CHUNK_BITS) | i])
                 for j in range(CHUNK) for i in range(CHUNK)]
        for rx in range(x0 // REGION, (x0 + CHUNK - 1) // REGION + 1):
            for ry in range(y0 // REGION, (y0 + CHUNK - 1) // REGION + 1):
                s = self.structure(rx, ry)
                if not s:
                    continue
                for (x, y), cell in s["cells"].items():
                    i, j = x - x0, y - y0
                    if 0 <= i < CHUNK and 0 <= j < CHUNK:
                        chunk[j * CHUNK + i] = cell
        self._chunks[key] = chunk
        if len(self._chunks) > CHUNK_CACHE:
            self._chunks.popitem(last=False)
        return chunk

    def cell(self, x, y):
        chunk = self._chunk(x >> CHUNK_BITS, y >> CHUNK_BITS)
        return chunk[((y & (CHUNK - 1)) << CHUNK_BITS) | (x & (CHUNK - 1))]

    # ---- helpers ---------------------------------------------------------
    def find_open_spot(self, x, y, need=1500, max_tries=400):
        """Nearest walkable cell to (x, y) that isn't on a tiny island."""
        seen = {(x, y)}
        frontier = deque([(x, y)])
        tries = 0
        while frontier and tries < max_tries:
            cx, cy = frontier.popleft()
            if self.cell(cx, cy)[0] in ("meadow", "woods", "scrub", "tundra", "forest"):
                tries += 1
                dry = all(self.kind(cx + dx, cy + dy) not in BAD_GROUND
                          for dx in range(-3, 4) for dy in range(-2, 3))
                if dry and self._room_to_roam(cx, cy, need):
                    return cx, cy
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if (nx, ny) not in seen and abs(nx - x) + abs(ny - y) < 3000:
                    seen.add((nx, ny))
                    frontier.append((nx, ny))
        return x, y

    def _room_to_roam(self, x, y, need):
        seen = {(x, y)}
        frontier = deque([(x, y)])
        while frontier:
            cx, cy = frontier.popleft()
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if (nx, ny) not in seen and walkable(self.cell(nx, ny)):
                    seen.add((nx, ny))
                    if len(seen) >= need:
                        return True
                    frontier.append((nx, ny))
        return False

    def cave(self, ex, ey):
        key = (ex, ey)
        if key not in self._caves:
            self._caves[key] = Cave(self, ex, ey)
            if len(self._caves) > 32:
                self._caves.popitem(last=False)
        return self._caves[key]


# --------------------------------------------------------------------------
# caves: small finite maps behind each cave mouth
# --------------------------------------------------------------------------
class Cave:
    W, H = 72, 36

    def __init__(self, world, ex, ey):
        self.world = world
        self.entrance = (ex, ey)
        rng = random.Random(hash2(ex, ey, world.seed, 900))
        W, H = self.W, self.H
        self.start = (W // 2, H // 2)
        wall = self._carve(rng)
        dist = self._distances(wall)
        # anything unreachable becomes rock
        cells = []
        for y in range(H):
            for x in range(W):
                if (x, y) in dist:
                    cells.append(world._make("cave_floor", x + ex * 7, y + ey * 7))
                else:
                    cells.append(world._make("cave_wall", x, y))
        self.cells = cells
        self._decorate(rng, dist)

    def _carve(self, rng):
        W, H = self.W, self.H
        sx, sy = self.start
        wall = [[rng.random() < 0.42 for _ in range(W)] for _ in range(H)]
        for step in range(5):
            new = [[True] * W for _ in range(H)]
            for y in range(1, H - 1):
                for x in range(1, W - 1):
                    n = sum(wall[y + dy][x + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
                    new[y][x] = n >= 5 or (step < 2 and n <= 1)
            wall = new
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    wall[sy + dy][sx + dx] = False
        # a few wandering tunnels so the cave is never a tiny closet
        for _ in range(3):
            x, y = sx, sy
            for _ in range(160):
                dx, dy = rng.choice(((1, 0), (-1, 0), (0, 1), (0, -1)))
                x = min(max(x + dx, 2), W - 3)
                y = min(max(y + dy, 2), H - 3)
                wall[y][x] = False
        return wall

    def _distances(self, wall):
        dist = {self.start: 0}
        frontier = deque([self.start])
        while frontier:
            x, y = frontier.popleft()
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (nx, ny) not in dist and not wall[ny][nx]:
                    dist[(nx, ny)] = dist[(x, y)] + 1
                    frontier.append((nx, ny))
        return dist

    def _set(self, x, y, cell):
        self.cells[y * self.W + x] = cell

    def _decorate(self, rng, dist):
        w = self.world
        floor = [p for p in dist if p != self.start]
        for kind, share in (("crystal", 0.02), ("mushrooms", 0.03), ("cave_pool", 0.02)):
            for x, y in rng.sample(floor, int(len(floor) * share)):
                self._set(x, y, w._make(kind, x, y))
        pool = ODDITY_POOLS.get("cave", [])
        if pool:
            far = sorted(floor, key=lambda p: dist[p])[len(floor) // 2:]
            for x, y in rng.sample(far, min(len(far), rng.randint(1, 3))):
                self._set(x, y, w._make("oddity", x, y, oddity=rng.choice(pool)))
        sx, sy = self.start
        self._set(sx, sy, w._make("cave_exit", sx, sy))

    def cell(self, x, y):
        if 0 <= x < self.W and 0 <= y < self.H:
            return self.cells[y * self.W + x]
        return self.world._make("cave_wall", 0, 0)
