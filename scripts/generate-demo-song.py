#!/usr/bin/env python3
"""Render the bundled demo session: two songs, four stems each.

Why this is synthesised from code instead of four checked-in files nobody can
reproduce: the demo ships inside the App Store and Google Play binaries, so its
authorship has to be provable with no third party in the chain. Every free
worship multitrack library we checked turns out to be licensed per-church, and
the free secular stem sets are Attribution-NonCommercial, which app stores rule
out.

Why *two* songs rather than one: a LibreTracks session is a setlist, and a
one-song demo shows none of that. Two regions with their own key, tempo and
time signature exercise what the app is actually for, and give an App Store
reviewer something to navigate rather than just play.

The audio is meant to be replaced. If real recorded stems ever arrive, only the
.mp3 files and the SONGS table below change: the resource wiring, the loader
command and the shape of the session document stay as they are.

    python scripts/generate-demo-song.py [out_dir]

Defaults to apps/desktop/src-tauri/resources/demo.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import wave

import numpy as np

SR = 44100
RNG = np.random.default_rng(20260910)  # fixed: the demo must render identically


# --------------------------------------------------------------------------
# Synthesis
# --------------------------------------------------------------------------

def midi_hz(note: float) -> float:
    return 440.0 * 2.0 ** ((note - 69) / 12.0)


def adsr(n: int, attack: float, decay: float, sustain: float, release: float):
    """Envelope in seconds. Every voice goes through one: a raw oscillator
    switched on and off clicks, and a click is the single artefact that makes a
    demo sound broken rather than plain."""
    a, d, r = int(attack * SR), int(decay * SR), int(release * SR)
    a = min(a, n)
    d = min(d, max(n - a, 0))
    r = min(r, max(n - a - d, 0))
    s = max(n - a - d - r, 0)
    return np.concatenate([
        np.linspace(0.0, 1.0, a, endpoint=False),
        np.linspace(1.0, sustain, d, endpoint=False),
        np.full(s, sustain),
        np.linspace(sustain, 0.0, r),
    ])[:n]


def osc(freq, dur, partials, env, detune=(0.0,), vibrato=0.0):
    """Additive voice. `detune` is in cents: two or three slightly detuned
    copies are what separate a pad from a sine wave — the beating between them
    is most of what the ear reads as "an instrument"."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for cents in detune:
        f = freq * 2.0 ** (cents / 1200.0)
        phase = 2 * np.pi * f * t
        if vibrato:
            phase = phase + vibrato * np.sin(2 * np.pi * 5.2 * t)
        for i, gain in enumerate(partials, start=1):
            out += gain * np.sin(i * phase)
    return out / len(detune) * adsr(n, *env)


def kick(dur=0.28):
    n = int(dur * SR)
    t = np.arange(n) / SR
    # Pitch envelope 130 Hz -> 45 Hz. A fixed-frequency sine reads as a beep.
    sweep = np.sin(2 * np.pi * np.cumsum(45.0 + 85.0 * np.exp(-t * 28.0)) / SR)
    click = RNG.standard_normal(n) * np.exp(-t * 420.0) * 0.08
    return (sweep + click) * adsr(n, 0.001, 0.06, 0.32, 0.16)


def snare(dur=0.20, level=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = RNG.standard_normal(n)
    noise = np.diff(np.concatenate([[0.0], noise]))  # crude high-pass
    body = np.sin(2 * np.pi * 185.0 * t) + 0.6 * np.sin(2 * np.pi * 246.0 * t)
    return (0.7 * noise + 0.3 * body) * adsr(n, 0.001, 0.05, 0.18, 0.12) * level


def hat(dur=0.055, level=1.0):
    n = int(dur * SR)
    noise = RNG.standard_normal(n)
    for _ in range(2):  # two differences = steeper high-pass, less "shh"
        noise = np.diff(np.concatenate([[0.0], noise]))
    return noise * adsr(n, 0.001, 0.012, 0.06, 0.03) * level


def reverb_ir(seconds=1.1, predelay=0.012):
    """Exponentially decaying noise, band-limited. Not a real room, but the
    single biggest difference between "a song" and "a test signal": dry
    synthesis sounds like measurement equipment however good the notes are."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = RNG.standard_normal(n) * np.exp(-t * 4.2)
    # Tame the top end so the tail sits behind the source instead of hissing.
    ir = np.convolve(ir, np.ones(24) / 24, mode="same")
    ir[: int(predelay * SR)] = 0.0
    return ir / np.max(np.abs(ir))


IR = reverb_ir()


def with_reverb(signal, amount):
    """FFT convolution. A per-sample filter loop over 40 s in Python takes
    minutes; this takes milliseconds."""
    if amount <= 0:
        return signal
    size = 1 << int(np.ceil(np.log2(len(signal) + len(IR))))
    wet = np.fft.irfft(np.fft.rfft(signal, size) * np.fft.rfft(IR, size))[: len(signal)]
    peak = float(np.max(np.abs(wet)))
    if peak > 0:
        wet = wet / peak * float(np.max(np.abs(signal)))
    return signal * (1.0 - amount * 0.35) + wet * amount


# --------------------------------------------------------------------------
# The songs
# --------------------------------------------------------------------------
# `parts` per section decides which stems play. That arrangement contrast is
# what makes this read as a song with a shape rather than one loop repeated.

SONGS = [
    {
        "slug": "adelante",
        "title": "Adelante",
        "key": "G",
        "bpm": 88.0,
        "beats_per_bar": 4,
        "signature": "4/4",
        # (bass root, chord voicing) per bar — I-V-vi-IV in G.
        "progression": [
            (43, [55, 59, 62]),   # G
            (38, [54, 57, 62]),   # D/F#
            (40, [55, 59, 64]),   # Em
            (36, [52, 55, 60]),   # C
        ],
        "scale": [67, 69, 71, 74, 76, 79],  # G major pentatonic, melody range
        "sections": [
            ("intro", "Intro", 0, 4, {"teclado"}),
            ("verse", "Estrofa", 4, 8, {"teclado", "bajo", "bateria"}),
            ("chorus", "Estribillo", 8, 12, {"teclado", "bajo", "bateria", "melodia"}),
            ("outro", "Final", 12, 16, {"teclado", "bajo"}),
        ],
    },
    {
        "slug": "descanso",
        "title": "Descanso",
        "key": "D",
        "bpm": 72.0,
        "beats_per_bar": 3,
        "signature": "3/4",
        "progression": [
            (38, [57, 62, 66]),   # D
            (45, [57, 61, 64]),   # A
            (47, [59, 62, 66]),   # Bm
            (43, [55, 59, 62]),   # G
        ],
        "scale": [66, 69, 71, 74, 78, 81],  # D major, higher and sparser
        "sections": [
            ("intro", "Intro", 0, 3, {"teclado"}),
            ("verse", "Estrofa", 3, 6, {"teclado", "bajo"}),
            ("chorus", "Estribillo", 6, 9, {"teclado", "bajo", "bateria", "melodia"}),
            ("outro", "Final", 9, 12, {"teclado"}),
        ],
    },
]

# (slug, track name, colour, reverb send). Drums stay dry-ish and the pad sits
# furthest back, which is roughly where they belong in a real mix.
STEMS = [
    ("bateria", "Bateria", "#e0625f", 0.18),
    ("bajo", "Bajo", "#e8a33d", 0.05),
    ("teclado", "Teclado", "#4c9f70", 0.42),
    ("melodia", "Melodia", "#5a8fd6", 0.30),
]


def place(buf, start_seconds, chunk):
    i = int(start_seconds * SR)
    end = min(i + len(chunk), len(buf))
    if end > i:
        buf[i:end] += chunk[: end - i]


def render_song(song):
    """Render one song into four stem buffers. Returns (stems, seconds)."""
    beat = 60.0 / song["bpm"]
    bar = song["beats_per_bar"] * beat
    bars = song["sections"][-1][3]
    total = int(bars * bar * SR) + int(1.6 * SR)  # tail for release + reverb
    stems = {name: np.zeros(total) for name, _label, _colour, _reverb in STEMS}

    def parts_at(bar_index):
        for _kind, _label, start, end, parts in song["sections"]:
            if start <= bar_index < end:
                return parts
        return set()

    for bar_index in range(bars):
        t0 = bar_index * bar
        root, chord = song["progression"][bar_index % len(song["progression"])]
        parts = parts_at(bar_index)

        if "teclado" in parts:
            for note in chord:
                place(stems["teclado"], t0, 0.13 * osc(
                    midi_hz(note), bar * 0.97, (1.0, 0.45, 0.2, 0.08),
                    (0.12, 0.3, 0.7, 0.5), detune=(-7.0, 0.0, 7.0)))

        if "bajo" in parts:
            # Root on the downbeat, fifth halfway: enough movement to be a bass
            # line, not enough to fight the melody.
            place(stems["bajo"], t0, 0.4 * osc(
                midi_hz(root), beat * 1.7, (1.0, 0.4, 0.16, 0.06),
                (0.008, 0.12, 0.6, 0.3)))
            if song["beats_per_bar"] == 4:
                place(stems["bajo"], t0 + 2 * beat, 0.34 * osc(
                    midi_hz(root + 7), beat * 1.5, (1.0, 0.35, 0.14),
                    (0.008, 0.12, 0.55, 0.3)))

        if "bateria" in parts:
            if song["beats_per_bar"] == 4:
                for b in (0, 2):
                    place(stems["bateria"], t0 + b * beat, 0.62 * kick())
                for b in (1, 3):
                    place(stems["bateria"], t0 + b * beat, 0.34 * snare())
                for eighth in range(8):
                    # Alternating accent: a flat hi-hat line sounds programmed.
                    level = 1.0 if eighth % 2 == 0 else 0.55
                    place(stems["bateria"], t0 + eighth * beat / 2,
                          0.07 * hat(level=level))
            else:
                place(stems["bateria"], t0, 0.62 * kick())
                for b in (1, 2):
                    place(stems["bateria"], t0 + b * beat, 0.22 * snare(level=0.7))
                for b in range(3):
                    place(stems["bateria"], t0 + b * beat,
                          0.07 * hat(level=1.0 if b == 0 else 0.5))

        if "melodia" in parts:
            # One phrase per bar, drawn deterministically from the scale so the
            # line stays diatonic without being the same four notes every time.
            scale = song["scale"]
            steps = ([(0, 1.0), (2, 1.0), (1, 2.0)] if bar_index % 2 == 0
                     else [(3, 1.5), (2, 0.5), (0, 1.0)])
            cursor = t0
            for degree_offset, beats in steps:
                if cursor - t0 + beats * beat > bar:
                    break
                degree = (bar_index + degree_offset) % len(scale)
                place(stems["melodia"], cursor, 0.22 * osc(
                    midi_hz(scale[degree]), beats * beat * 0.92,
                    (1.0, 0.3, 0.15, 0.07), (0.03, 0.14, 0.62, 0.25),
                    detune=(-4.0, 4.0), vibrato=0.08))
                cursor += beats * beat

    return stems, bars * bar


# --------------------------------------------------------------------------
# Render, encode, and emit the session document
# --------------------------------------------------------------------------

demo_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                        else "apps/desktop/src-tauri/resources/demo")
audio_dir = demo_dir / "audio"
audio_dir.mkdir(parents=True, exist_ok=True)

GAP_SECONDS = 2.0
regions, clips, markers, tempo_markers, signature_markers = [], [], [], [], []
expected_files = set()
timeline = 0.0

for song in SONGS:
    stems, song_seconds = render_song(song)
    song_dir = audio_dir / song["slug"]
    song_dir.mkdir(parents=True, exist_ok=True)

    for name, _label, _colour, reverb_amount in STEMS:
        signal = with_reverb(stems[name], reverb_amount)
        peak = float(np.max(np.abs(signal)))
        # -3 dBFS: leaves the mixer somewhere to go. Four stems summing to
        # exactly 0 dBFS would clip the moment anyone raises a fader.
        if peak > 0:
            signal = signal / peak * 0.7079
        pcm = (np.clip(signal, -1.0, 1.0) * 32767.0).astype("<i2")

        wav_path = song_dir / f"{name}.wav"
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(SR)
            handle.writeframes(pcm.tobytes())

        mp3_path = song_dir / f"{name}.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
             "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3_path)],
            check=True,
        )
        wav_path.unlink()
        expected_files.add(mp3_path.relative_to(audio_dir).as_posix())

        clips.append({
            "id": f"clip-{song['slug']}-{name}",
            "trackId": f"track-{name}",
            # Relative to the session folder, so the demo survives being copied
            # under whatever name the user's new session gets.
            "filePath": f"audio/{song['slug']}/{name}.mp3",
            "timelineStartSeconds": round(timeline, 3),
            "sourceStartSeconds": 0.0,
            "durationSeconds": round(song_seconds, 3),
            "gain": 1.0,
            "fadeInSeconds": None,
            "fadeOutSeconds": None,
        })

    beat = 60.0 / song["bpm"]
    bar = song["beats_per_bar"] * beat
    regions.append({
        "id": f"region-{song['slug']}",
        "name": song["title"],
        "startSeconds": round(timeline, 3),
        "endSeconds": round(timeline + song_seconds, 3),
        "transposeSemitones": 0,
        "key": song["key"],
        "warpEnabled": False,
        "warpSourceBpm": None,
        "master": {"gain": 1.0},
    })
    tempo_markers.append({
        "id": f"tempo-{song['slug']}",
        "startSeconds": round(timeline, 3),
        "bpm": song["bpm"],
    })
    signature_markers.append({
        "id": f"signature-{song['slug']}",
        "startSeconds": round(timeline, 3),
        "signature": song["signature"],
    })
    for kind, label, start_bar, _end_bar, _parts in song["sections"]:
        markers.append({
            "id": f"marker-{song['slug']}-{kind}",
            "name": label,
            "startSeconds": round(timeline + start_bar * bar, 3),
            "digit": None,
            "kind": kind,
        })

    timeline += song_seconds + GAP_SECONDS

# Stems dropped from the arrangement used to linger here. Nothing downstream
# notices — they are not in the session document, so no test fails — they just
# ride into the App Store and Google Play builds as dead weight.
for stale in sorted(audio_dir.rglob("*"), reverse=True):
    relative = stale.relative_to(audio_dir).as_posix()
    if stale.is_file() and relative not in expected_files:
        stale.unlink()
        print(f"eliminado obsoleto: {relative}")
    elif stale.is_dir() and not any(stale.iterdir()):
        stale.rmdir()
        print(f"eliminada carpeta vacia: {relative}")

total_seconds = timeline - GAP_SECONDS
song_document = {
    "version": 7,
    "id": "song_demo",
    "title": "Demo de LibreTracks",
    "artist": "LibreTracks",
    "key": SONGS[0]["key"],
    "bpm": SONGS[0]["bpm"],
    "timeSignature": SONGS[0]["signature"],
    "durationSeconds": round(total_seconds, 3),
    "tempoMarkers": tempo_markers,
    "timeSignatureMarkers": signature_markers,
    "regions": regions,
    "tracks": [{
        "id": f"track-{name}",
        "name": label,
        "kind": "audio",
        "parentTrackId": None,
        "volume": 1.0,
        "pan": 0.0,
        "muted": False,
        "solo": False,
        "transposeEnabled": True,
        "audioTo": "master",
        "color": colour,
        "autoCreated": False,
        "collapsed": False,
    } for name, label, colour, _reverb in STEMS],
    "clips": clips,
    "midiClips": [],
    "sectionMarkers": markers,
}

session_path = demo_dir / "song.ltsession"
session_path.write_text(json.dumps(song_document, indent=2, ensure_ascii=True) + "\n",
                        encoding="utf-8")

total_bytes = sum(path.stat().st_size for path in audio_dir.rglob("*.mp3"))
print(f"\n{len(SONGS)} canciones | {len(clips)} clips | "
      f"{total_seconds:.1f}s | audio {total_bytes / 1024 / 1024:.1f} MiB")
for song in SONGS:
    print(f"  {song['title']:12s} {song['key']:3s} {song['bpm']:5.0f} BPM  "
          f"{song['signature']}")
