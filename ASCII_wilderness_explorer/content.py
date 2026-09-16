"""
content.py -- the "add silly stuff here" file.

Everything flavorful lives in this file: terrain looks, abandoned structures,
weird discoveries, ambient messages, and the little effects discoveries can
trigger. The engine (worldgen.py / explore.py) just reads these tables.
After editing, run:  python3 -m pytest -q   (it catches most typos)

Quick recipes
-------------
* New weird discovery: add a dict to ODDITIES (at the bottom).
      {"text": "A vending machine. It only sells regret.", "biomes": {"meadow"}}
  "biomes" is optional (leave it out = can appear anywhere on land). Use
  "cave" for underground-only things. To make something happen, add
  "effect": fx_something -- write the fx_ function in the EFFECTS section
  just above ODDITIES, or name it as a string: "effect": "fx_something".

* New abandoned structure: add a dict to STRUCTURES with some ASCII art.
  Art legend:  '#' wall   '.' floor   '+' door   '?' a discovery spot
               ' ' (space) = leave the natural terrain alone
               '`' = blank ground (e.g. inside a sign, so no trees grow there)
               any other character is drawn as-is and you can walk on it.
  Optional "oddities": ["...", "..."] gives its '?' spots their own texts.
  Keep it under ~40x40 and make sure every '?' can be walked to.

* New ambient message: add a line to AMBIENT under a terrain name.
  Messages can be long-ish; they wrap onto two lines (~150 characters max).

Biomes: sand, meadow, woods, forest, swamp, scrub, tundra, taiga, hills,
mountain (and "cave" for discoveries underground).
Colors: green, dark_green, olive, blue, dark_blue, cyan, sand, yellow, orange,
brown, red, pink, magenta, purple, grey, dark_grey, white.
"""

import random


def tile(glyphs, color, name, walk=True):
    """glyphs: characters picked at random per cell (repeat one to weight it)."""
    return {"glyphs": glyphs, "color": color, "name": name, "walk": walk}


# --------------------------------------------------------------------------
# TERRAIN -- how every kind of ground looks. Keys are used by the engine.
# --------------------------------------------------------------------------
TERRAIN = {
    # overworld
    "deep_water": tile("~", "dark_blue", "deep lake", walk=False),
    "water":      tile("~~~~-", "blue", "shallows"),
    "river":      tile("~", "cyan", "river"),
    "sand":       tile("....:", "sand", "shore"),
    "meadow":     tile("....,,'\"", "green", "meadow"),
    "woods":      tile("T..,.'", "green", "open woods"),
    "forest":     tile("TTTt", "dark_green", "forest"),
    "swamp":      tile("\",~.,", "olive", "swamp"),
    "scrub":      tile("..;.,;", "sand", "scrubland"),
    "tundra":     tile("........'*", "white", "tundra"),
    "taiga":      tile("YYy.", "cyan", "snowy pines"),
    "hills":      tile("nn.'", "brown", "hills"),
    "mountain":   tile("^^^n", "grey", "mountains"),
    "peak":       tile("A", "white", "jagged peak", walk=False),
    "cave":       tile("O", "orange", "cave mouth"),
    # underground
    "cave_wall":  tile("#", "dark_grey", "rock", walk=False),
    "cave_floor": tile("....,", "grey", "cave"),
    "cave_exit":  tile("<", "yellow", "way out"),
    "crystal":    tile("*", "cyan", "crystals"),
    "mushrooms":  tile("\"", "purple", "glowing mushrooms"),
    "cave_pool":  tile("~", "blue", "underground pool"),
    # structure pieces (color comes from the structure itself)
    "wall":       tile("#", "brown", "wall", walk=False),
    "rubble":     tile("%,", "brown", "rubble"),
    "floor":      tile(".", "brown", "old floor"),
    "door":       tile("+", "brown", "doorway"),
    # discoveries
    "oddity":     tile("?", "magenta", "something odd"),
    "found":      tile("!", "dark_grey", "something you already found"),
}

# Which terrains count as "land" that discoveries can appear on.
LAND = {"sand", "meadow", "woods", "forest", "swamp", "scrub",
        "tundra", "taiga", "hills", "mountain"}


# --------------------------------------------------------------------------
# STRUCTURES -- abandoned things stamped onto the world.
# biomes: terrain names the structure's center must be on.
# decay: chance (0-1) that each wall has crumbled into rubble.
# --------------------------------------------------------------------------
STRUCTURES = [
    {
        "name": "abandoned cabin",
        "biomes": {"woods", "forest", "taiga", "meadow"},
        "color": "brown",
        "decay": 0.15,
        "text": "An abandoned cabin. Someone left a kettle on the stove, decades ago.",
        "oddities": [
            "A guestbook. The last entry reads: 'Lovely stay. The kettle is still on.'",
            "A rocking chair, rocking slowly. It stops, politely, when you look at it.",
            "A jar of pickles labeled FOR EMERGENCIES. There has never been a pickle emergency.",
        ],
        "art": """
#######
#..?..#
#.....+
###.###
""",
    },
    {
        "name": "stone circle",
        "biomes": {"meadow", "hills", "tundra", "scrub"},
        "color": "grey",
        "decay": 0.0,
        "text": "A ring of standing stones. They hum, very quietly, in B flat.",
        "art": """
  o   o
o       o

o   ?   o

o       o
  o   o
""",
    },
    {
        "name": "ruined watchtower",
        "biomes": {"hills", "mountain", "scrub"},
        "color": "grey",
        "decay": 0.3,
        "text": "A crumbling watchtower. Whatever it was watching for never came. Probably.",
        "oddities": [
            "A guard's logbook: 'Day 400. Nothing. Day 401. A bird. Day 402. Same bird.'",
            "A spyglass pointed at the horizon. Through it, the horizon waves back.",
        ],
        "art": """
 ##+##
##...##
#..?..#
##...##
 #####
""",
    },
    {
        "name": "deserted campsite",
        "biomes": {"woods", "meadow", "sand", "scrub", "forest"},
        "color": "orange",
        "decay": 0.0,
        "text": "A campsite. The fire is cold, but the marshmallows are still warm.",
        "art": """
 /\\     /\\
/__\\ ? /__\\
  = (*) =
""",
    },
    {
        "name": "rusted car",
        "biomes": {"meadow", "scrub", "woods", "tundra"},
        "color": "red",
        "decay": 0.0,
        "text": "A rusted-out car with no road anywhere near it. The radio is still on.",
        "oddities": [
            "The glovebox holds a map of this exact spot, with a note: 'You made it!'",
            "A pine air freshener. After all these years it still smells like a pine.",
        ],
        "art": """
  _____
_/_|?|_\\_
'-o---o-'
""",
    },
    {
        "name": "fire lookout",
        "biomes": {"mountain", "hills", "taiga", "forest"},
        "color": "brown",
        "decay": 0.1,
        "text": "A fire lookout. Last log entry: 'Saw a tree. Lovely tree. Not on fire.'",
        "oddities": [
            "A pair of binoculars, pointed very deliberately at one particular cloud.",
            "A bird-watching list. Every bird on it is named Kevin.",
        ],
        "art": """
 _____________
 | ######### |
 | #.......# |
 | #.[]..?.# |
 | #.....o.# |
 | ####+#### |
 |_____H_____|
      /H\\
     / H \\
    /  H  \\
""",
    },
    {
        "name": "boarded-up mine",
        "biomes": {"mountain", "hills", "tundra"},
        "color": "orange",
        "decay": 0.2,
        "text": "A boarded-up mine. The sign says: GONE DIGGING. BACK WHEN WE FIND IT.",
        "oddities": [
            "A canary-sized hard hat hangs on a nail. It has been lovingly polished.",
            "A mine cart full of rocks, each one labeled 'probably not gold'.",
        ],
        "art": """
   _/\\_/\\/\\_/\\_
  /            \\
 /  ##########  \\
    #...::...#
    #..?.....#
    ##.X==X.##
      |    |
      |====|
      |    |
      |====|
""",
    },
    {
        "name": "lonely bus stop",
        "biomes": {"scrub", "meadow", "tundra", "sand"},
        "color": "yellow",
        "decay": 0.0,
        "text": "A bus stop. The next bus is due 'once you have made peace with it'.",
        "oddities": [
            "A timetable. Every bus is listed as 'soon'. One just says 'no'.",
            "A lost umbrella, folded neatly on the bench. It is not raining. It might, though.",
        ],
        "art": """
  ____________
 |``BUS`STOP``|  _
 |____________| |=|
  |``````````|  |=|
  |``======``|  |
  |````?`````|  |
 _|__________|__|_
""",
    },
    {
        "name": "glassless greenhouse",
        "biomes": {"swamp", "woods", "meadow"},
        "color": "yellow",
        "decay": 0.3,
        "text": "A glassless greenhouse. The tomatoes have formed a small government.",
        "oddities": [
            "A tomato wearing a tiny sash that reads MAYOR.",
            "A seed packet labeled MYSTERY. Something grew out of it and wandered off.",
        ],
        "art": """
####################
#&&.v.v.v.#.*.*.&&.#
#&........:........#
+....?.........&...+
#&........:........#
#&&.v.v.v.#.*.*.&&.#
########:######:####
""",
    },
    {
        "name": "shuttered diner",
        "biomes": {"scrub", "sand", "meadow"},
        "color": "pink",
        "decay": 0.1,
        "text": "A shuttered diner. The specials board still reads: SOUP OF THE DAY: TUESDAY.",
        "oddities": [
            "A jukebox with one song on it, titled 'Song'. It is, in fairness, a song.",
            "A pie under a glass dome. A card says DO NOT EAT. IT IS LOAD-BEARING.",
        ],
        "art": """
 _________________
|```EAT`````PIE```|
|_________________|
 ########+########
 #...............#
 #.[].[].[].[]...#
 #...............#
 #===========.===#
 #.o.o.o.o.o..?..#
 #################
""",
    },
    {
        "name": "phone booth",
        "biomes": {"taiga", "tundra", "swamp"},
        "color": "red",
        "decay": 0.0,
        "text": "A lone phone booth. It rings once, politely, then decides you look busy.",
        "oddities": [
            "The phone crackles: 'Tomorrow: cloudy, with a chance of Thursday.'",
            "A phone book with exactly one entry. It is the number for this phone booth.",
        ],
        "art": """
  _____      __
 |PHONE|    (``)
 |=====|     ||
 |`[=]`|     ||
 |``?``|     ||
 |`````|     ||
 |_____|    _||_
""",
    },
    {
        "name": "lighthouse",
        "biomes": {"sand"},
        "color": "red",
        "decay": 0.15,
        "text": "A lighthouse. The keeper's log: 'Kept it lit. Kept it lit. Went for a walk.'",
        "oddities": [
            "A foghorn. You honk it. Far away, something honks back, a little shyly.",
            "A message in a bottle. It says: 'Got your message. Thanks. - The Sea'.",
        ],
        "art": """
     \\  |  /
      ( * )
     /  |  \\
      [___]
      |###|
      |...|
      |###|    _____
      |...|   /_____\\
     /|###|\\  |..?.|
    /_|.+.|_\\ |_+__|
""",
    },
    {
        "name": "mossy playground",
        "biomes": {"woods", "swamp", "meadow"},
        "color": "cyan",
        "decay": 0.25,
        "text": "A playground. The sign says NO RUNNING. The moss has been very good about it.",
        "oddities": [
            "A swing, still swinging gently. There is no wind.",
            "A sandbox with a perfect sandcastle. A tiny flag says KEEP OUT (PLEASE).",
            "A seesaw, perfectly level, with nobody on either end.",
        ],
        "art": """
####################
#&  |\\     _____  &#
#   | \\    |   |   #
#   |  \\   |[] |   #
#   |___\\  |   |   +
#                  #
#  .....     ?  && #
#  .....   o====o  #
#&&     &&     && &#
####################
""",
    },
    {
        "name": "ranger station",
        "biomes": {"forest", "taiga", "woods"},
        "color": "olive",
        "decay": 0.1,
        "text": "A ranger station. DAYS SINCE INCIDENT: 11,402. The incident is not described.",
        "oddities": [
            "A logbook. Every entry says 'Quiet day.' The last one says 'Quiet day?'",
            "A pamphlet titled SO YOU'VE MET A BEAR. Page two just says 'nice'.",
        ],
        "art": """
    |>
    |
 ##################
 #......#.........#
 #.[]...+.....?...#
 #......#.........#
 #..o...#.o....o..#
 ########+#########
         :
   ______:______
         :
""",
    },
    {
        "name": "crashed satellite",
        "biomes": {"mountain", "hills", "scrub"},
        "color": "grey",
        "decay": 0.05,
        "text": "A crashed satellite, still beaming home a very detailed report about moss.",
        "oddities": [
            "A plaque: IF FOUND, PLEASE RETURN TO SPACE. POSTAGE PAID.",
            "A button marked DO NOT PRESS. You don't. The satellite beeps its thanks.",
        ],
        "art": """
   '    ,     '
 ,    _-""-_     ,
      |[]  |
 #### | ?  | ####
 #==#-|====|-#==#
 #### | () | ####
      |____|
 ,     /||\\     '
   '    ||    ,
""",
    },
    {
        "name": "giant's picnic blanket",
        "biomes": {"meadow", "hills"},
        "color": "red",
        "decay": 0.0,
        "text": "A picnic blanket the size of a pond. One boulder-sized grape, saved for later.",
        "oddities": [
            "A note in enormous handwriting: BACK SOON. PLEASE DON'T EAT THE GRAPE.",
            "A napkin the size of a bedsheet, folded with tremendous care.",
            "A crumb you could comfortably sleep on. You briefly consider it.",
        ],
        "art": """
 ____________________
|::  ::  ::  ::  ::  |
|  ::  ::  ::  ::  ::|
|::  _______   ___   |
|  ::|=====| _/'..\\_:|
|::  |_____|(.......)|
|  ::  ::  ::\\_____/:|
|::  ::  ?:  ::  ::  |
|  ::  ::  ::  ::  ::|
'--------------------'
""",
    },
    {
        "name": "hallway to nowhere",
        "biomes": {"forest", "swamp", "taiga"},
        "color": "purple",
        "decay": 0.2,
        "text": "A hallway with no house around it. A framed photo shows this exact hallway.",
        "oddities": [
            "A welcome mat that reads: WELCOME. ALSO, WHY?",
            "A light switch. You flip it. Somewhere, a sunset gets slightly dimmer.",
            "A radiator, humming away, heating the great outdoors one degree at a time.",
        ],
        "art": """
####+#####+#####+#####
#.[].....[].....[]...#
+::::::::::::?:::::::+
#....................#
#####+#####+#####+####
""",
    },
]


# --------------------------------------------------------------------------
# AMBIENT -- random flavor lines while walking through a terrain.
# "night" lines can appear anywhere after dark.
# --------------------------------------------------------------------------
AMBIENT = {
    "forest": [
        "An owl says something rude.",
        "Pine needles crunch underfoot.",
        "Somewhere, a woodpecker is working overtime.",
        "A tree creaks. Another tree creaks back. You were not invited into this conversation.",
        "You pass a knot shaped like a door. You knock. Nobody is home, thankfully.",
        "The moss here is thick and soft. It has clearly never had a bad day.",
    ],
    "woods": [
        "A squirrel judges you from a branch.",
        "Dappled light. Very nice.",
        "A deer watches you, decides you are a stump, and goes back to eating.",
        "A fallen log lies across the path, as if waiting for someone to sit on it.",
        "A breeze moves through the leaves. It sounds like a crowd politely clapping.",
    ],
    "meadow": [
        "The grass sways like it's listening to music.",
        "A bee bumps into you and apologizes.",
        "A butterfly lands on your sleeve, reads the care label, and leaves.",
        "The wildflowers here are arranged almost, but not quite, alphabetically.",
        "Somewhere nearby, a cow moos. There are no cows here. You check twice.",
    ],
    "water": [
        "Your boots are now 40% pond.",
        "A fish swims up, looks at your ankle, and hurries off to tell the others.",
        "The water is cold enough to make you reconsider several past decisions.",
        "You wade past a lily pad with a tiny sign on it: RESERVED.",
    ],
    "river": [
        "The river is in a hurry to be somewhere.",
        "A stick floats by. A second stick floats by, clearly chasing the first.",
        "The river chatters over the stones. It is mostly gossip about the lake.",
        "You skip a flat stone. It skips eleven times and does not come back.",
    ],
    "swamp": [
        "Something goes 'bloop'.",
        "The mud tries to keep your left boot.",
        "A frog clears its throat, then decides not to say anything after all.",
        "The fog here moves a little slower whenever you look at it.",
        "A heron stands on one leg, waiting for something that is also in no hurry.",
    ],
    "mountain": [
        "The wind up here has opinions.",
        "A pebble clatters down forever.",
        "A goat stands calmly on a ledge that should not be able to hold a goat.",
        "You can see three valleys from here. One of them waves.",
        "The air is thin up here. So is your list of reasons to keep climbing.",
    ],
    "hills": [
        "You crest a hill and feel briefly heroic.",
        "The hills roll gently, as if something large is breathing underneath. Probably not.",
        "A sheep watches you pass. It has seen many walkers. You are one of them.",
        "Every downhill here is paid back promptly with an uphill.",
    ],
    "tundra": [
        "Your breath hangs in the air like a tiny ghost.",
        "The horizon is very far away and seems content to stay there.",
        "A white hare blinks at you, then goes back to being a patch of snow.",
        "The snow squeaks underfoot, as if warning someone that you are coming.",
    ],
    "taiga": [
        "Snow slides off a branch directly down your collar.",
        "The pines stand in neat rows, like they are queueing for something.",
        "An owl turns its head all the way around to keep you in view.",
        "Everything is so hushed that your own footsteps feel a little rude.",
    ],
    "scrub": [
        "A tumbleweed tumbles. It has somewhere to be.",
        "A lizard does four push-ups on a warm rock, then looks at you expectantly.",
        "The heat shimmers. The horizon is a lake for a moment, then a horizon again.",
        "A cactus has grown in the exact shape of a shrug.",
    ],
    "sand": [
        "A crab scuttles sideways, avoiding eye contact.",
        "The waves keep arriving and leaving, like guests who forgot something.",
        "You hold a seashell to your ear. It asks how you have been.",
        "A gull walks beside you for a while, as if you are on the same errand.",
    ],
    "cave_floor": [
        "Drip. ... Drip. ... Drip.",
        "Your footsteps echo back slightly out of sync.",
        "A bat hangs upside down and watches you walk the wrong way up.",
        "The walls glitter faintly, as if the cave put on its good jewelry.",
        "A stalagmite has a small handwritten sign on it: PLEASE DO NOT LICK.",
    ],
    "night": [
        "The stars are very loud tonight.",
        "Something howls, then giggles.",
        "A firefly spells out a word you almost recognize.",
        "The moon looks at you with mild interest, then goes back to being the moon.",
        "A cricket choir starts up, loses its place, and begins again from the top.",
        "A shooting star goes by. You make a wish. It says it will see what it can do.",
    ],
}

ENTER_CAVE = [
    "You duck into the cave. Your torch sputters to life.",
    "The cave smells like wet stone and old secrets.",
    "It's dark. You are not likely to be eaten by a grue. Probably.",
    "You step inside. The cave clears its throat, and the echo takes a message.",
    "Inside, the air cools and your voice drops to a respectful whisper on its own.",
    "A hand-lettered sign just inside reads: MIND THE DARK. It seems sincere.",
    "The daylight follows you in a few steps, then loses its nerve and goes back.",
]

COMPANION_CHATTER = [
    "{name} hums tunelessly.",
    "{name} seems pleased with the view.",
    "{name} is still following you.",
    "{name} points out a cloud shaped like a slightly different cloud.",
    "{name} stops to study a leaf for a long time. You wait.",
    "{name} has been counting your steps, and gets a different number than you.",
    "{name} makes a small noise that is probably approval.",
    "{name} has a question, but decides it can wait until later.",
    "{name} trips over nothing, looks around, and pretends it was on purpose.",
    "{name} has found a stick and is very proud of it.",
    "{name} walks a little closer when the path gets narrow.",
]

# "You curl up and sleep until dawn. You dream of ..."
DREAMS = [
    "enormous moths.",
    "a very polite bear.",
    "the ocean, which you have never seen.",
    "being a map.",
    "a staircase that only goes sideways.",
    "a lake that is shy and moves whenever you look at it.",
    "a moose explaining taxes to you, slowly, twice.",
    "a door in the sky with your name spelled slightly wrong.",
    "an owl who is also, somehow, a lighthouse.",
    "a sandwich that remembers you fondly.",
    "counting sheep, until the sheep start counting you back.",
    "a library of books about you. They are all fine.",
]


# --------------------------------------------------------------------------
# EFFECTS -- functions a discovery can trigger. Each takes the game.
# Handy game methods:  game.say(text)   game.teleport(dx, dy)
#   game.pass_time(turns)   game.add_companion(glyph, color, name)
#   game.trip(turns)   game.x / game.y / game.turn / game.day_length
#   game.underground   game.camp (x, y)   game.companions (list of dicts)
# --------------------------------------------------------------------------
def fx_teleport(game):
    dx, dy = random.randint(-400, 400), random.randint(-400, 400)
    game.teleport(dx, dy)
    game.say("The world folds. You are somewhere else.")


def fx_nightfall(game):
    game.pass_time(game.day_length // 2)
    game.say("You blink. Hours have passed.")


def fx_trip(game):
    game.trip(60)
    game.say("Colors are now optional.")


def fx_pet_rock(game):
    if game.add_companion("o", "grey", "Gerald"):
        game.say("A small rock starts following you. You name it Gerald.")


def fx_duck(game):
    if game.add_companion("d", "yellow", "A duck"):
        game.say("A duck falls in line behind you. It has chosen you.")


def fx_tiny_cloud(game):
    if not game.add_companion("&", "white", "A very small cloud"):
        return  # add_companion already explained that the cloud declined
    if game.underground:
        game.say("The cloud bumps along the cave ceiling behind you. It has never been indoors before.")
    else:
        game.say("A very small cloud drifts after you. Now and then it rains, briefly, on your left shoulder.")


def fx_camp_compass(game):
    if game.underground:
        game.say("The needle points straight up and will not discuss it until you are outside.")
        return
    if tuple(game.camp) == (game.x, game.y):
        game.say("The needle points at your feet. Camp is already here. The compass seems relieved.")
        return
    game.camp = (game.x, game.y)
    game.say("The needle points firmly at your feet. Fine. Camp is here now.")


def fx_exact_map(game):
    was_underground = game.underground
    x0, y0 = game.where()[1]   # your spot on the surface
    game.teleport(random.choice((-1, 1)) * random.randint(20, 60),
                  random.choice((-1, 1)) * random.randint(20, 60))
    dx, dy = game.x - x0, game.y - y0   # the route you actually took
    legs = [f"{abs(n)} step{'s' * (abs(n) != 1)} {way}"
            for n, way in ((dx, "east" if dx > 0 else "west"), (dy, "south" if dy > 0 else "north"))
            if n]
    route = ", then ".join(legs) or "nowhere at all"
    game.pass_time(abs(dx) + abs(dy))
    if was_underground:
        game.say(f"You follow the map up and out: {route}. You arrive, more or less.")
    else:
        game.say(f"You follow the map exactly: {route}. You arrive, more or less.")


def fx_goose(game):
    if not game.companions:
        game.say("A goose looks you over, finds nothing to take, and leaves a note: 'TRAVEL LIGHTER. -G'")
        return
    pal = game.companions.pop(random.randrange(len(game.companions)))
    name = pal.get("name") if isinstance(pal, dict) else None
    game.say(f"{name or 'Someone'} is led away by a goose. The goose leaves a note: 'BORROWED. -G'")


def fx_dawn_bell(game):
    into_day = game.turn % game.day_length
    if game.time_of_day() == "dawn":
        game.say("You ring the bell. It is already dawn, so the sun just nods at you.")
        return
    game.pass_time(game.day_length - into_day)
    if game.underground:
        game.say("The bell rings. Far overhead, you somehow know, the sun is scrambling up.")
    else:
        game.say("The bell rings. The sun hurries around the world and rises, a bit out of breath.")


def fx_naming_hat(game):
    if not game.companions:
        game.say("You try on the hat. It looks for someone to rename, finds only you, and sulks.")
        return
    names = ["Biscuit", "Sir Reginald", "Tuesday", "Mustard", "Professor Wobble", "Little Gary",
             "Dame Pebble", "Captain Snack", "Moss", "Doug", "Parsnip", "Lady Fog", "Waffles",
             "Old Tom"]
    picks = random.sample(names, min(len(names), len(game.companions)))
    for i, pal in enumerate(game.companions):
        if isinstance(pal, dict):
            pal["name"] = picks[i % len(picks)]
    if len(game.companions) == 1:
        game.say(f"You try on the hat. Your companion is now called {picks[0]}, and always has been.")
    else:
        game.say(f"You try on the hat. It renames all {len(game.companions)} of your companions. "
                 f"{picks[0]} is thrilled.")


# --------------------------------------------------------------------------
# ODDITIES -- weird discoveries marked '?' on the map.
# --------------------------------------------------------------------------
ODDITIES = [
    # anywhere on land
    {"text": "A mailbox in the middle of nowhere. Inside: a letter to you, dated tomorrow."},
    {"text": "A single, perfectly clean bathtub full of warm water."},
    {"text": "A door standing on its own. You open it.", "effect": fx_teleport},
    {"text": "A sign that reads: YOU ARE HERE. The arrow points slightly to the left of you."},
    {"text": "A pocket watch, ticking very fast. You watch it for a while.", "effect": fx_nightfall},
    {"text": "A rock with googly eyes glued on.", "effect": fx_pet_rock},
    {"text": "A signpost reads: ELSEWHERE, 0 KM. You take one step in that direction.",
     "effect": fx_teleport},
    {"text": "A folding chair facing nothing in particular. You sit. Nothing in particular is lovely today."},
    {"text": "A laminated notice: THIS WILDERNESS CLOSED THURSDAY FOR MAINTENANCE. It doesn't say which Thursday."},
    {"text": "A patch of ground exactly one degree warmer than everywhere else. A cat is already asleep on it."},
    {"text": "A coat rack with your coat on it. You are also wearing your coat. Best not to think about it."},
    {"text": "A garden gnome facing away from you. You walk around it. It is still facing away from you."},
    {"text": "A compass whose needle ignores north and points at your boots instead.",
     "effect": fx_camp_compass},
    {"text": "A map drawn on a napkin: one dotted line, two numbers, and a very confident X.",
     "effect": fx_exact_map},
    {"text": "A tall hat on a tree stump. A card inside says: NAMES ASSIGNED. NO REFUNDS.",
     "effect": fx_naming_hat},

    # shore
    {"text": "A pond-sized puddle containing exactly one duck.",
     "biomes": {"meadow", "sand", "swamp", "woods"}, "effect": fx_duck},
    {"text": "A shipwreck. There is no ocean for 900 miles.", "biomes": {"sand", "scrub"}},
    {"text": "A message in a bottle: 'Got your bottle. Doing fine. Please stop writing.' You don't remember writing.",
     "biomes": {"sand"}},
    {"text": "A knee-high lighthouse, earnestly sweeping its beam to warn off a nearby beetle.",
     "biomes": {"sand"}},
    {"text": "A tiny lifeguard chair staffed by a duck. Its shift ends just as you walk up.",
     "biomes": {"sand"}, "effect": fx_duck},
    {"text": "A shimmering lake with a small sign: THIS IS A MIRAGE. NO LIFEGUARD ON DUTY.",
     "biomes": {"sand", "scrub"}},
    {"text": "A goose on a stump, looking over your party like a shopper at a market.",
     "biomes": {"hills", "meadow", "sand", "swamp", "woods"}, "effect": fx_goose},

    # meadows
    {"text": "A scarecrow with a clipboard, surveying the crows on how scary it is. So far: 'not very'.",
     "biomes": {"meadow"}},
    {"text": "A dandelion clock. You blow on it and the seeds drift off, taking the next few hours with them.",
     "biomes": {"meadow"}, "effect": fx_nightfall},
    {"text": "A field of sunflowers, all turned toward you instead of the sun. It seems rude to leave.",
     "biomes": {"meadow"}},
    {"text": "A flock of sheep arranged to spell HELP. No, wait - HELLO. One of them was running late.",
     "biomes": {"hills", "meadow"}},
    {"text": "A cloud the size of a sheep, snagged on a fence post. You untangle it.",
     "biomes": {"hills", "meadow", "scrub", "tundra"}, "effect": fx_tiny_cloud},

    # woods
    {"text": "A ring of mushrooms. You step inside it. Oh no.",
     "biomes": {"cave", "forest", "swamp", "woods"}, "effect": fx_trip},
    {"text": "A treehouse with a sign: NO GROWNUPS. You respect this.",
     "biomes": {"forest", "woods"}},
    {"text": "A hollow log with a doormat and a tiny sign: BEWARE OF THE SNAIL. The snail is napping.",
     "biomes": {"woods"}},
    {"text": "A lost-and-found box nailed to a tree. Inside: one mitten, three keys, and most of a Tuesday.",
     "biomes": {"woods"}},
    {"text": "A squirrel wearing a tiny backpack, clearly also out for a hike. You exchange a nod.",
     "biomes": {"woods"}},
    {"text": "A knot in a tree trunk shaped exactly like your face. It looks a little tired. So do you.",
     "biomes": {"forest", "woods"}},
    {"text": "A brass bell hanging from a branch. Its tag reads: FOR EMERGENCY SUNRISES.",
     "biomes": {"forest", "mountain", "taiga", "woods"}, "effect": fx_dawn_bell},

    # forests
    {"text": "Every tree in this clearing has a neat little label that says TREE. Someone was very thorough.",
     "biomes": {"forest"}},
    {"text": "A fox in reading glasses, halfway through a very thick book. It shushes you.",
     "biomes": {"forest"}},
    {"text": "A hollow tree with a hand-painted sign: SHORTCUT. You squeeze inside.",
     "biomes": {"forest"}, "effect": fx_teleport},

    # swamps
    {"text": "A frog on a lily pad bangs a tiny gavel and finds you not guilty. Of what, it doesn't say.",
     "biomes": {"swamp"}},
    {"text": "A rowboat in the reeds with a sign: FERRY - LEAVES WHEN IT FEELS LIKE IT. You sit down to wait.",
     "biomes": {"swamp"}, "effect": fx_nightfall},
    {"text": "A bubble rises from the mud and pops with a tiny 'hello'. Something down there is being friendly.",
     "biomes": {"swamp"}},
    {"text": "A will-o'-the-wisp holding up a sign: PLEASE DO NOT FOLLOW. ONGOING SITUATION.",
     "biomes": {"swamp"}},

    # scrubland
    {"text": "A payphone rings. A voice asks if you've seen a tortoise. You look down. A tortoise shakes its head.",
     "biomes": {"scrub"}},
    {"text": "A glowing cactus flower. You sniff it, which in hindsight was a choice.",
     "biomes": {"scrub"}, "effect": fx_trip},
    {"text": "A duck, very far from any water, holding a tiny map upside down. It looks at you with relief.",
     "biomes": {"mountain", "scrub"}, "effect": fx_duck},

    # tundra
    {"text": "A snowman wearing sunglasses. It seems cooler than you.",
     "biomes": {"taiga", "tundra"}},
    {"text": "An igloo with a FOR SALE sign. Asking price: one warm sock. Must see inside to appreciate.",
     "biomes": {"tundra"}},
    {"text": "A penguin, very lost, asks you for directions. You both agree south is probably that way.",
     "biomes": {"tundra"}},
    {"text": "A small tear in the sky overhead, neatly patched with a square of slightly different sky.",
     "biomes": {"tundra"}},
    {"text": "A fish frozen in the ice, looking up at you, unimpressed. It blinks. You're fairly sure fish can't.",
     "biomes": {"tundra"}},
    {"text": "A snowflake the size of a dinner plate, on a velvet cushion. Its placard says: UNIQUE (VERIFIED).",
     "biomes": {"taiga", "tundra"}},

    # snowy pines
    {"text": "A moose at a tiny desk, stamping passports. Yours now says VISITED: HERE.",
     "biomes": {"taiga"}},
    {"text": "A ski trail that runs straight up the trunk of a pine and stops at the top. Someone had a plan.",
     "biomes": {"taiga"}},
    {"text": "A row of snow angels, each smaller than the last, trailing off into the trees. The last is very tiny.",
     "biomes": {"taiga"}},

    # hills
    {"text": "A flag at the summit, planted by 'Dave, probably'.", "biomes": {"hills", "mountain"}},
    {"text": "A zipper runs up the side of this hill. You decide not to open it.",
     "biomes": {"hills"}},
    {"text": "A kite string runs from a peg up into the clouds. You tug it. Something up there tugs back, gently.",
     "biomes": {"hills"}},
    {"text": "A telescope on a tripod. Far away, someone is looking back at you through theirs. You both wave.",
     "biomes": {"hills", "mountain"}},

    # mountains
    {"text": "You shout hello off the cliff. The echo shouts back: 'Office hours are nine to five.'",
     "biomes": {"mountain"}},
    {"text": "A cable car station with no cables, and a very patient queue of pebbles.",
     "biomes": {"mountain"}},

    # underground
    {"text": "A cave painting of a person holding a smartphone.", "biomes": {"cave"}},
    {"text": "An underground lemonade stand. 5 cents. Nobody is working it.", "biomes": {"cave"}},
    {"text": "A glowing crystal that whispers your wifi password.", "biomes": {"cave"}},
    {"text": "A book club of bats, hanging in a small circle. Nobody has done the reading.",
     "biomes": {"cave"}},
    {"text": "An underground pool reflecting a blue, sunny sky with a bird crossing it. You look up. Rock.",
     "biomes": {"cave"}},
    {"text": "A sticky note on the cave wall: 'Gone deeper. Don't wait up.' It is signed, simply, 'The Dark'.",
     "biomes": {"cave"}},
    {"text": "A pebble that has sat alone in the dark for ten thousand years. It would like to see the sky.",
     "biomes": {"cave"}, "effect": fx_pet_rock},
    {"text": "A tiny cloud, lost underground, very glad to see someone.",
     "biomes": {"cave"}, "effect": fx_tiny_cloud},
    {"text": "A map scratched into the cave wall. The dotted line goes up and out.",
     "biomes": {"cave"}, "effect": fx_exact_map},
]
