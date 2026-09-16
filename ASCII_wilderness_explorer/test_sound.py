"""
Sound checks. Run with:  python3 -m pytest -q
These never make noise: the "audio player" is a stand-in Python command.
"""

import re
import sys
import time
import wave

import pytest

import content
import explore
import sound
import worldgen

QUIET = [sys.executable, "-c", "import time; time.sleep(0.3)"]
LONG = [sys.executable, "-c", "import time; time.sleep(30)"]
BROKEN = [sys.executable, "-c", "raise SystemExit(1)"]
BEEPS = {name: "sine: A4 .05" for name in "abcdef"}   # so editing content.SOUNDS can't break these


def make(tmp_path, player, **kw):
    return sound.Sound(content.SOUNDS, content.MUSIC, str(tmp_path / "cache"), player=player, **kw)


def wait_for(condition, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.05)
    return False


# ---- recipes ------------------------------------------------------------------
@pytest.mark.parametrize("name", sorted(content.SOUNDS))
def test_sound_recipes_parse_and_do_not_clip(name):
    recipe = content.SOUNDS[name]
    samples = sound.render_effect(recipe)
    assert len(samples) <= sound.RATE * 3, "keep effects under 3 seconds"
    peak = max(map(abs, samples), default=0) * sound.EFFECT_VOLUME
    assert peak <= 1.0, f"{name!r} would clip ({peak:.2f}); lower its *volume"


def test_every_sound_the_game_asks_for_exists():
    source = open(explore.__file__).read() + open(content.__file__).read()
    wanted = set(re.findall(r'cue\(["\'](\w+)["\']\)', source))
    wanted |= set(explore.STEP_SOUNDS.values()) | {"step", "dawn", "night"}
    wanted |= {o["sound"] for o in worldgen.ODDITIES if o.get("sound")}
    missing = wanted - set(content.SOUNDS)
    assert not missing, f"add these to content.SOUNDS: {sorted(missing)}"


@pytest.mark.parametrize("mood", sorted(content.MUSIC))
def test_music_moods_compose(mood):
    samples = sound.compose(content.MUSIC[mood], mood, length=6)
    assert len(samples) == 6 * sound.MUSIC_RATE
    peak = max(map(abs, samples)) * sound.MUSIC_VOLUME
    assert peak > 0.01, f"{mood!r} is silent"
    assert peak <= 1.0, f"{mood!r} would clip ({peak:.2f}); lower its echo or volumes"


def test_every_mood_the_game_picks_has_music():
    assert {"day", "night", "cave", "snow", "trip"} <= set(content.MUSIC)


@pytest.mark.parametrize("bad", ["sine C4 .1", "flute: C4 .1", "sine: H4 .1", "sine: C4",
                                 "sine: C .1", "sine: C4 0", "sine: C12 .1", "sine*x: C4 .1"])
def test_bad_recipes_explain_themselves(bad):
    with pytest.raises(ValueError):
        sound.parse(bad)


@pytest.mark.parametrize("change", [{"beat": 0}, {"beat": -1}, {"echo": 5}, {"scale": "C4"}])
def test_odd_music_settings_still_finish(change):
    samples = sound.compose(dict(content.MUSIC["day"], **change), "x", length=4)
    assert len(samples) == 4 * sound.MUSIC_RATE


def test_a_misspelled_music_wave_is_an_error():
    with pytest.raises(ValueError):
        sound.compose(dict(content.MUSIC["day"], wave="trianlge"), "x", length=2)


def test_notes_are_in_tune():
    assert sound.note_freq("A4") == 440
    assert round(sound.note_freq("C4"), 2) == 261.63
    assert sound.note_freq("Bb3") == sound.note_freq("A#3")


def test_wav_files_are_valid(tmp_path):
    path = str(tmp_path / "beep.wav")
    sound.write_wav(path, sound.render_effect("sine: A4 .1"), sound.RATE, 0.5)
    with wave.open(path) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, sound.RATE)
        assert w.getnframes() == int(0.1 * sound.RATE)


# ---- playing ------------------------------------------------------------------
def test_no_player_means_quiet_not_crashing(tmp_path):
    audio = make(tmp_path, None)
    audio.play("discover")
    audio.set_mood("day")
    audio.set_enabled(True)
    assert audio.problem and not audio.working
    audio.close()


def test_effects_are_capped_rate_limited_and_cleaned_up(tmp_path):
    audio = sound.Sound(BEEPS, {}, str(tmp_path), player=QUIET)
    audio.play("a")
    audio.play("a")
    assert len(audio._playing) == 1
    for name in "bcdef":
        audio.play(name)
    assert len(audio._playing) == sound.MAX_EFFECTS
    audio.close()
    assert audio._playing == []


def test_muted_means_silent(tmp_path):
    audio = make(tmp_path, QUIET, enabled=False)
    audio.play("discover")
    audio.set_mood("day")
    time.sleep(0.3)
    assert audio._playing == [] and audio._music_proc is None
    audio.close()


def test_a_broken_player_gives_up_with_a_message(tmp_path):
    audio = sound.Sound(BEEPS, {}, str(tmp_path), player=BROKEN)
    for name in "abcd":
        audio.play(name)
        assert wait_for(lambda: all(p.poll() is not None for p, _ in audio._playing))
        audio._reap()
    assert not audio.working
    assert "No sound" in audio.problem
    audio.set_enabled(False)
    audio.set_enabled(True)   # turning it back on tries again
    assert audio.working and audio.problem is None
    audio.close()


def test_music_plays_switches_and_stops(tmp_path):
    audio = make(tmp_path, LONG)
    audio.set_mood("day")
    assert wait_for(lambda: audio._music_proc is not None)
    first = audio._music_proc
    audio.set_mood("cave")          # caves switch right away
    assert wait_for(lambda: audio._music_proc is not first)
    assert first.poll() is not None
    second = audio._music_proc
    audio.set_enabled(False)
    assert wait_for(lambda: second.poll() is not None)
    audio.close()
    assert not audio._thread.is_alive()


# ---- the game side --------------------------------------------------------------
def test_walking_asks_for_sounds_and_the_ui_takes_them():
    game = explore.Game(3)
    for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        game.move(*d)
    assert game.cues
    explore.play_cues(game, None)
    assert game.cues == []


def test_cues_cannot_pile_up():
    game = explore.Game(3)
    for _ in range(100):
        game.cue("step")
    assert len(game.cues) <= 16


def test_music_follows_the_game():
    game = explore.Game(3)
    assert explore.music_mood(game) in ("day", "snow")
    game.pass_time(explore.DAY_LENGTH * 0.7)
    assert explore.music_mood(game) == "night"
    game.trip(10)
    assert explore.music_mood(game) == "trip"


def test_sound_setting_is_remembered(tmp_path, monkeypatch):
    monkeypatch.setattr(explore, "SAVE_DIR", str(tmp_path))
    assert explore.load_settings() == {"sound": True}
    audio = make(tmp_path, QUIET)
    game = explore.Game(3)
    settings = explore.load_settings()
    explore.toggle_sound(game, audio, settings)
    assert not audio.enabled and explore.load_settings() == {"sound": False}
    assert game.messages[-1].startswith("Sound off")
    explore.toggle_sound(game, audio, settings)
    assert audio.enabled and explore.load_settings() == {"sound": True}
    assert "blip" in game.cues
    audio.close()
    (tmp_path / "settings.json").write_text("[not, json")
    assert explore.load_settings() == {"sound": True}


def test_a_broken_recipe_is_reported_not_fatal(tmp_path):
    audio = sound.Sound({"oops": "sine: C4 .1", "bad": 5}, {"day": {"scale": "X9"}},
                        str(tmp_path), player=LONG)
    audio.play("bad")
    assert "'bad'" in audio.problem
    audio.set_mood("day")
    assert wait_for(lambda: "'day'" in (audio.problem or ""))
    time.sleep(1.5)
    assert audio._thread.is_alive() and audio._music_proc is None
    audio.close()


def test_footsteps_are_the_first_sounds_to_go():
    played = []

    class Recorder:
        enabled = True

        def play(self, name):
            played.append(name)

        def set_mood(self, mood):
            pass

    game = explore.Game(3)
    for name in ("step", "discover", "step", "quack", "friend", "splash"):
        game.cue(name)
    explore.play_cues(game, Recorder())
    assert played == ["discover", "quack", "friend"]
