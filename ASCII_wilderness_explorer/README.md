# ASCII Wilderness Explorer

An endless, procedurally generated wilderness for your terminal. Wander through
forests, mountains, lakes, rivers, and tundra. Poke around abandoned
structures, duck into caves, and run into the occasional very weird thing.

There's no combat, no inventory, and no way to lose.

```
python3 explore.py            # continue your last wander (or start one)
python3 explore.py --new      # a brand new random world
python3 explore.py --seed 42  # visit world 42 (resumes it if you've been there)
python3 explore.py --postcard --seed 42 --at 300,-200 --size 100x30   # peek without playing
```

Needs Python 3.8+ and nothing else. On Windows, run `pip install windows-curses` first.

## Keys

| key | does |
| --- | --- |
| arrows / WASD / hjkl | walk |
| shift + arrow, or capital `WASD` / `HJKL` | run (stops at new sights and at edges like shores) |
| space or `.` | wait a moment |
| `z` | sleep until dawn |
| `c` | make camp here (the status bar points back to it) |
| `m` | map (`+`/`-` to zoom) |
| `n` | notebook: everything you've found |
| `p` | save a postcard of the view to `postcards/` |
| `<` / `>` | climb out of a cave (stand on the `<`) / go into one (stand on an `O`) |
| `?` | help |
| `q` | quit (your game saves automatically to `saves/`) |

In the world: `?` is something odd (walk onto it), `O` is a cave mouth (walk in),
`<` leads out of a cave, `!` is something you've already found, `A` is an
impassable peak, and dark blue `~` lakes are too deep to wade.

## Adding silly things

All the flavor lives in **`content.py`**, and the recipes are at the top of that file:

- **A weird discovery:** add a dict to `ODDITIES`:
  `{"text": "A vending machine that only sells regret.", "biomes": {"meadow"}}`
- **Something that *happens*:** write a small `fx_` function (you get the `game`)
  and add `"effect": fx_your_thing` to a discovery.
- **An abandoned structure:** add ASCII art to `STRUCTURES`. In the art, `#` is a
  wall, `.` is floor, `+` is a door, `?` is a discovery spot, a space leaves the
  land alone, `` ` `` is blank ground, and any other character is walkable
  decoration.
- **Ambient chatter:** add lines to `AMBIENT` under a terrain name.
- **More or fewer surprises:** tweak `ODDITY_CHANCE`, `CAVE_CHANCE` and
  `STRUCTURE_CHANCE` at the top of `worldgen.py`.

After adding things, run `python3 -m pytest -q`. The tests catch typos in biome
names, missing effect functions, and structures whose `?` spots are walled in.

## How it works

- `worldgen.py` builds the world from layered value noise (elevation, moisture,
  temperature, rivers). The same seed always gives the same world. Terrain is
  generated in 32x32 chunks as you walk; climate is sampled every 4 cells and
  blended, which keeps each step fast. Each 48x48 region may hold one
  structure, and each cave mouth leads to its own small cellular-automata cave.
- `explore.py` holds the game rules and the curses UI.
- `content.py` holds all the silly stuff.
