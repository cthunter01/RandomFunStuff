"""
sound.py -- little synthesized sound effects and ambient music.

No audio libraries: sounds are built from sine/triangle/square/saw/noise
waves with plain math, saved as WAV files, and played in the background by
the system's own player (pw-play, paplay or aplay on Linux, afplay on macOS,
ffplay or mpv anywhere). If none works, the game is simply quiet.
Set WILDERNESS_PLAYER="some-player --flags" to pick one yourself.

The recipes live in content.py (SOUNDS and MUSIC). A recipe looks like
    "triangle*0.6: C6 .07, E6 .07, G6 .3 + noise*0.2: C7>C5 .2"
i.e. layers joined by " + ", each "wave[*volume]: note seconds, ...", where a
note is C4 / F#5 / Bb3, a number of Hz, "-" for a pause, or "C4>G5" to slide.
"""

import array
import hashlib
import math
import os
import random
import shlex
import shutil
import subprocess
import sys
import threading
import time
import wave

RATE = 22050                 # effects
MUSIC_RATE = 11025           # music is soft and low; half the rate renders twice as fast
EFFECT_VOLUME = 0.6
MUSIC_VOLUME = 0.25
MUSIC_LENGTH = 24.0          # seconds per music loop
MUSIC_VARIANTS = 3           # different loops per mood, played in turn
URGENT_MOODS = {"cave", "trip"}   # switch to/from these right away, not at the end of a loop
MAX_EFFECTS = 4              # effects playing at once
MIN_GAP = 0.25               # seconds before the same effect can play again
VERSION = 2                  # bump to re-render every cached sound

PLAYERS = [
    ["pw-play"],
    ["paplay"],
    ["aplay", "-q"],
    ["afplay"],
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
    ["mpv", "--no-video", "--really-quiet"],
]
WAVES = {"sine", "triangle", "square", "saw", "noise"}
_SEMITONES = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}


# --------------------------------------------------------------------------
# recipes
# --------------------------------------------------------------------------
def note_freq(name):
    """'A4' -> 440.0; also 'C#5', 'Bb3', or a plain number of Hz."""
    try:
        hz = float(name)
    except ValueError:
        letter, rest = name[:1].upper(), name[1:]
        if letter not in _SEMITONES:
            raise ValueError(f"{name!r} isn't a note (try C4, F#5 or Bb3)") from None
        shift = 0
        while rest[:1] in ("#", "b"):
            shift += 1 if rest[0] == "#" else -1
            rest = rest[1:]
        try:
            octave = int(rest)
        except ValueError:
            raise ValueError(f"{name!r} needs an octave number, like {letter}4") from None
        hz = 440.0 * 2 ** ((_SEMITONES[letter] + shift + (octave - 4) * 12) / 12)
    if not 20 <= hz <= 10000:
        raise ValueError(f"{name!r} is outside what we can play (20-10000 Hz)")
    return hz


def parse(recipe):
    """Recipe text -> [(wave, volume, [(from_hz or None, to_hz, seconds), ...]), ...]"""
    layers = []
    for part in recipe.split("+"):
        if not part.strip():
            continue
        head, sep, body = part.partition(":")
        if not sep:
            raise ValueError(f"{part.strip()!r} needs 'wave: notes', e.g. 'sine: C5 .1'")
        wave_name, _, vol = head.partition("*")
        wave_name = wave_name.strip()
        if wave_name not in WAVES:
            raise ValueError(f"unknown wave {wave_name!r} (use one of {', '.join(sorted(WAVES))})")
        volume = float(vol) if vol else 1.0
        notes = []
        for item in body.split(","):
            bits = item.split()
            if len(bits) != 2:
                raise ValueError(f"{item.strip()!r} should be 'note seconds', e.g. 'C5 .1'")
            pitch, seconds = bits[0], float(bits[1])
            if not 0 < seconds <= 60:
                raise ValueError(f"{item.strip()!r}: seconds must be between 0 and 60")
            if pitch == "-":
                notes.append((None, None, seconds))
            else:
                a, _, b = pitch.partition(">")
                notes.append((note_freq(a), note_freq(b or a), seconds))
        layers.append((wave_name, volume, notes))
    return layers


# --------------------------------------------------------------------------
# synthesis
# --------------------------------------------------------------------------
def _layer(wave_name, notes, rate, rng, attack=0.005, release=0.3):
    """One voice as a list of floats. release = share of each note spent fading out."""
    out = []
    phase = 0.0
    held = 0.0
    tau = 2 * math.pi
    for f0, f1, seconds in notes:
        n = max(1, int(seconds * rate))
        if f0 is None:
            out.extend([0.0] * n)
            continue
        a = max(1, min(int(attack * rate), n // 4))
        r = max(1, min(max(int(release * n), int(0.01 * rate)), n - a))
        step = f0 / rate
        grow = (f1 / f0) ** (1.0 / n)
        buf = [0.0] * n
        for i in range(n):
            phase += step
            step *= grow
            if phase >= 1.0:
                phase -= int(phase)
                if wave_name == "noise":
                    held = rng.uniform(-1.0, 1.0)
            if wave_name == "sine":
                v = math.sin(tau * phase)
            elif wave_name == "triangle":
                v = 4.0 * abs(phase - 0.5) - 1.0
            elif wave_name == "square":
                v = 0.5 if phase < 0.5 else -0.5     # squares are loud; halve them
            elif wave_name == "saw":
                v = phase - 0.5
            else:
                v = held
            env = i / a if i < a else 1.0
            left = n - i
            if left < r:
                env *= left / r
            buf[i] = v * env
        out.extend(buf)
    return out


def _mix(voices, length):
    total = [0.0] * length
    for gain, samples in voices:
        for i, v in enumerate(samples[:length]):
            total[i] += v * gain
    return total


def _echo(samples, delay, feedback):
    for i in range(delay, len(samples)):
        samples[i] += samples[i - delay] * feedback
    return samples


def _fade(samples, rate, fade_in, fade_out):
    n = len(samples)
    a, b = min(n, int(fade_in * rate)), min(n, int(fade_out * rate))
    for i in range(a):
        samples[i] *= i / a
    for i in range(b):
        samples[n - 1 - i] *= i / b
    return samples


def render_effect(recipe, rng=None):
    rng = rng or random.Random(0)
    voices = [(vol, _layer(w, notes, RATE, rng)) for w, vol, notes in parse(recipe)]
    length = max((len(v) for _, v in voices), default=0)
    return _mix(voices, length)


def compose(spec, seed, length=MUSIC_LENGTH):
    """A generative ambient loop: a wandering melody over a soft drone."""
    rng = random.Random(seed)
    wave_name = spec.get("wave", "triangle")
    if wave_name not in WAVES:
        raise ValueError(f"unknown wave {wave_name!r} (use one of {', '.join(sorted(WAVES))})")
    scale = [note_freq(n) for n in spec["scale"].split()]
    beat = max(0.05, float(spec.get("beat", 0.5)))
    density = float(spec.get("notes", 0.5))
    legato = min(1.0, max(0.05, float(spec.get("legato", 0.8))))
    echo = min(0.8, max(0.0, float(spec.get("echo", 0))))
    melody, t, idx = [], 0.0, rng.randrange(len(scale))
    while t < length - 2 * beat:
        dur = beat * rng.choice((1, 1, 1, 2))
        if rng.random() < density:
            idx = rng.choice([i for i in (idx - 2, idx - 1, idx - 1, idx, idx + 1, idx + 1, idx + 2)
                              if 0 <= i < len(scale)])
            melody.append((scale[idx], scale[idx], dur * legato))
            if legato < 1:
                melody.append((None, None, dur * (1 - legato)))
        else:
            melody.append((None, None, dur))
        t += dur
    melody.append((None, None, max(0.01, length - t)))
    n = int(length * MUSIC_RATE)
    tune = _layer(wave_name, melody, MUSIC_RATE, rng)
    if echo:
        _echo(tune, int(beat * 0.75 * MUSIC_RATE), echo)
    voices = [(float(spec.get("melody", 0.5)), tune)]
    drones = spec.get("drone", "").split()
    for name in drones:
        f = note_freq(name)
        voices.append((float(spec.get("hum", 0.35)) / len(drones),
                       _layer("sine", [(f, f, length)], MUSIC_RATE, rng, release=0.02)))
    return _fade(_mix(voices, n), MUSIC_RATE, 1.5, 2.5)


def write_wav(path, samples, rate, volume):
    pcm = array.array("h", (int(max(-1.0, min(1.0, v * volume)) * 32767) for v in samples))
    if sys.byteorder == "big":
        pcm.byteswap()
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm.tobytes())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):   # a full disk leaves half a file behind
            os.remove(tmp)


# --------------------------------------------------------------------------
# playing
# --------------------------------------------------------------------------
def find_player():
    custom = os.environ.get("WILDERNESS_PLAYER")
    if custom:
        try:
            cmd = shlex.split(custom)
        except ValueError:
            return None
        return cmd if cmd and shutil.which(cmd[0]) else None
    for cmd in PLAYERS:
        if shutil.which(cmd[0]):
            return cmd
    return None


class Sound:
    """Plays effects on request and loops mood music in a background thread."""

    def __init__(self, effects, music, cache_dir, enabled=True, player="auto"):
        self.effects = effects
        self.music = music
        self.cache_dir = cache_dir
        self.enabled = enabled
        self.player = find_player() if player == "auto" else player
        if os.environ.get("WILDERNESS_PLAYER") and player == "auto":
            missing = f"can't run WILDERNESS_PLAYER ({os.environ['WILDERNESS_PLAYER']})"
        else:
            missing = "no audio player found (" + ", ".join(cmd[0] for cmd in PLAYERS) + ")"
        self.problem = None if self.player else f"(No sound: {missing}. M turns sound off.)"
        self._broken = set()         # sounds that couldn't be made (M off/on tries again)
        self.mood = None
        self._last = {}
        self._playing = []
        self._failures = 0
        self._worked = False
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._music_proc = None
        self._thread = threading.Thread(target=self._music_loop, name="music", daemon=True)
        self._thread.start()

    @property
    def working(self):
        return self.player is not None and self._failures < 3

    def set_enabled(self, on):
        self.enabled = on
        if on and self.player:   # give a player that failed earlier another chance
            with self._lock:
                self._failures = 0
                self.problem = None
                self._broken.clear()
        if not on:
            self._stop_effects()
        self._wake.set()

    def set_mood(self, mood):
        if mood != self.mood:
            self.mood = mood
            self._wake.set()

    def play(self, name):
        """Play a named effect from the recipes (quietly does nothing if it can't)."""
        recipe = self.effects.get(name)
        if not (self.enabled and self.working and recipe):
            return
        now = time.monotonic()
        if now - self._last.get(name, -1.0) < MIN_GAP:
            return
        self._reap()
        if len(self._playing) >= MAX_EFFECTS:
            return
        self._last[name] = now
        path = self._cached(name, ("effect", recipe), lambda: render_effect(recipe),
                            RATE, EFFECT_VOLUME)
        proc = path and self._spawn(path)
        if proc:
            self._playing.append((proc, now))

    def close(self):
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=2)
        self._stop_effects()

    # ---- helpers -------------------------------------------------------
    def _cached(self, name, key, make, rate, volume):
        digest = hashlib.sha1(repr((key, rate, volume, VERSION)).encode()).hexdigest()[:16]
        path = os.path.join(self.cache_dir, digest + ".wav")
        if path in self._broken:
            return None
        if not os.path.exists(path):
            try:
                os.makedirs(self.cache_dir, exist_ok=True)
                write_wav(path, make(), rate, volume)
            except Exception as err:   # a typo in a recipe mustn't stop the game or the music
                self._broken.add(path)
                self.problem = f"(Sound {name!r} couldn't be made: {err})"
                return None
        return path

    def _spawn(self, path):
        try:
            return subprocess.Popen(self.player + [path], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as err:
            self._failed(f"{self.player[0]} wouldn't start ({err.strerror})")
            return None

    def _failed(self, why):
        with self._lock:
            self._failures += 1
            if self._failures >= 3 and not self._worked:
                self.problem = f"(No sound: {why}. M turns sound off.)"

    def _check_exit(self, proc, started, stopped_by_us):
        if stopped_by_us:
            return
        if proc.returncode == 0:
            with self._lock:
                self._worked, self._failures = True, 0
        elif time.monotonic() - started < 5:
            self._failed(f"{self.player[0]} keeps failing")

    def _reap(self):
        still = []
        for proc, started in self._playing:
            if proc.poll() is None:
                still.append((proc, started))
            else:
                self._check_exit(proc, started, False)
        self._playing = still

    def _stop_effects(self):
        for proc, _ in self._playing:
            if proc.poll() is None:
                proc.terminate()
        for proc, _ in self._playing:
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        self._playing = []

    def _music_loop(self):
        turn = 0
        while not self._stop.is_set():
            try:
                turn = self._music_turn(turn)
            except Exception as err:   # never let the music thread die quietly
                self.problem = f"(Music stopped: {err})"
                self._wake.wait(1)
                self._wake.clear()

    def _music_turn(self, turn):
        """Play one loop of music (or wait a little). Returns the loop counter."""
        mood = self.mood
        spec = self.music.get(mood) if mood else None
        if not (self.enabled and self.working and spec):
            self._wake.wait(0.5)
            self._wake.clear()
            return turn
        variant = turn % MUSIC_VARIANTS
        path = self._cached(mood, ("music", mood, repr(spec), variant),
                            lambda: compose(spec, f"{mood}{variant}"), MUSIC_RATE, MUSIC_VOLUME)
        proc = path and self._spawn(path)
        if not proc:
            self._wake.wait(1)
            self._wake.clear()
            return turn + 1
        self._music_proc = proc
        started, stopped = time.monotonic(), False
        while proc.poll() is None:
            wanted = self.mood
            if (self._stop.is_set() or not self.enabled or
                    (wanted != mood and (wanted in URGENT_MOODS or mood in URGENT_MOODS))):
                proc.terminate()
                stopped = True
                break
            self._wake.wait(0.2)
            self._wake.clear()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        self._check_exit(proc, started, stopped)
        if not stopped:
            self._wake.wait(random.uniform(0.5, 2.0))   # a breath between loops
        return turn + 1
