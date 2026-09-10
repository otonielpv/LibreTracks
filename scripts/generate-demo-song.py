#!/usr/bin/env python3
"""Render the bundled demo song's four stems.

Why this exists as a script instead of four checked-in files nobody can
reproduce: the demo ships inside the App Store and Google Play binaries, so
its audio has to be provably ours. Synthesising it from source settles that
question permanently — there is no sample, no loop pack and no third party in
the chain.

The stems are deliberately plain. Their job is to make the first run of a DAW
show something instead of an empty timeline, and to give an App Store reviewer
a session that plays within seconds of opening the app. If real recorded
material ever replaces them, only the .mp3 files change: the resource wiring,
the loader command and the session JSON stay exactly as they are.

    python scripts/generate-demo-song.py [out_dir]

Defaults to apps/desktop/src-tauri/resources/demo/audio.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import wave

import numpy as np

SR = 44100
BPM = 88.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
BARS = 12

# I-V-vi-IV in G major, three times through: the most legible progression there
# is, so anyone hearing two bars knows the demo is music and not a test tone.
PROGRESSION = [
    ("G", 43, [55, 59, 62]),
    ("D", 38, [50, 54, 57]),
    ("Em", 40, [52, 55, 59]),
    ("C", 36, [48, 52, 55]),
] * 3


def midi_hz(note: int) -> float:
    return 440.0 * 2.0 ** ((note - 69) / 12.0)


def env(n: int, attack: float, decay: float, sustain: float, release: float) -> np.ndarray:
    """ADSR in seconds. Every voice goes through this: a raw sine switched on
    and off clicks, and a click is the one artefact that makes a demo sound
    broken rather than simple."""
    a, d, r = int(attack * SR), int(decay * SR), int(release * SR)
    a, d, r = min(a, n), min(d, max(n - a, 0)), min(r, max(n - a - d, 0))
    s = max(n - a - d - r, 0)
    return np.concatenate([
        np.linspace(0.0, 1.0, a, endpoint=False),
        np.linspace(1.0, sustain, d, endpoint=False),
        np.full(s, sustain),
        np.linspace(sustain, 0.0, r),
    ])[:n]


def tone(freq: float, dur: float, harmonics: tuple[float, ...], adsr) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for i, gain in enumerate(harmonics, start=1):
        out += gain * np.sin(2 * np.pi * freq * i * t)
    return out * env(n, *adsr)


def place(buf: np.ndarray, start: float, chunk: np.ndarray) -> None:
    i = int(start * SR)
    end = min(i + len(chunk), len(buf))
    if end > i:
        buf[i:end] += chunk[: end - i]


total = int(BARS * BAR * SR) + SR  # one second of tail for releases
bass = np.zeros(total)
keys = np.zeros(total)
drums = np.zeros(total)
lead = np.zeros(total)

for bar, (_name, root, chord) in enumerate(PROGRESSION):
    t0 = bar * BAR

    # Bass: root on beats 1 and 3, with a little body above the fundamental.
    for beat in (0, 2):
        place(bass, t0 + beat * BEAT,
              0.42 * tone(midi_hz(root), BEAT * 1.6, (1.0, 0.35, 0.12),
                          (0.006, 0.10, 0.62, 0.30)))

    # Keys: the chord held across the bar, soft enough to sit under the lead.
    for note in chord:
        place(keys, t0,
              0.14 * tone(midi_hz(note), BAR * 0.98, (1.0, 0.5, 0.22, 0.1),
                          (0.09, 0.25, 0.72, 0.45)))

    # Drums: kick 1 and 3, snare 2 and 4, hats on eighths.
    for beat in (0, 2):
        n = int(0.16 * SR)
        t = np.arange(n) / SR
        sweep = np.sin(2 * np.pi * (118.0 * np.exp(-t * 26.0) + 44.0) * t)
        place(drums, t0 + beat * BEAT, 0.55 * sweep * env(n, 0.001, 0.05, 0.25, 0.10))
    rng = np.random.default_rng(20260910)
    for beat in (1, 3):
        n = int(0.13 * SR)
        noise = rng.standard_normal(n)
        body = np.sin(2 * np.pi * 190.0 * np.arange(n) / SR)
        place(drums, t0 + beat * BEAT,
              0.30 * (0.75 * noise + 0.25 * body) * env(n, 0.001, 0.04, 0.16, 0.08))
    for eighth in range(8):
        n = int(0.05 * SR)
        hat = rng.standard_normal(n)
        hat = np.diff(np.concatenate([[0.0], hat]))  # crude high-pass
        place(drums, t0 + eighth * BEAT / 2,
              0.055 * hat * env(n, 0.001, 0.015, 0.08, 0.03))

# Lead: a four-bar diatonic phrase, repeated so the song has a shape. Degrees
# are scale steps of G major, not semitones.
G_MAJOR = [67, 69, 71, 72, 74, 76, 78, 79]
PHRASE = [
    (0, 4, 1.0), (2, 4, 1.0), (4, 3, 2.0), (2, 4, 1.0),
    (0, 4, 1.0), (1, 4, 1.0), (2, 3, 2.0), (4, 4, 1.0),
    (5, 4, 1.0), (4, 4, 1.0), (2, 3, 2.0), (0, 4, 1.0),
    (1, 4, 1.0), (2, 4, 1.0), (0, 3, 3.0),
]
for repeat in range(3):
    cursor = repeat * 4 * BAR
    for degree, _unused, beats in PHRASE:
        dur = beats * BEAT
        if cursor + dur > 4 * BAR * (repeat + 1):
            break
        place(lead, cursor,
              0.20 * tone(midi_hz(G_MAJOR[degree]), dur * 0.94, (1.0, 0.28, 0.14, 0.06),
                          (0.02, 0.12, 0.66, 0.22)))
        cursor += dur

demo_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                        else "apps/desktop/src-tauri/resources/demo")
out_dir = demo_dir / "audio"
out_dir.mkdir(parents=True, exist_ok=True)

STEMS = [
    ("bateria", "Bateria", "#e0625f", drums),
    ("bajo", "Bajo", "#e8a33d", bass),
    ("teclado", "Teclado", "#4c9f70", keys),
    # No "Guia": ese nombre es de la voz guia, otra feature, y un stem
    # llamado asi haria pensar que la demo trae los avisos de seccion.
    ("melodia", "Melodia", "#5a8fd6", lead),
]

# Drop stems that no longer belong to the arrangement. Renaming one used to
# leave the old file behind, and nothing downstream would notice: it is not in
# the session document, so no test fails — it just rides into the App Store and
# Google Play builds as dead weight.
KEEP = {f"{name}.mp3" for name, _label, _color, _signal in STEMS}
for stale in out_dir.iterdir():
    if stale.is_file() and stale.name not in KEEP:
        stale.unlink()
        print(f"eliminado obsoleto: {stale.name}")

for name, _label, _color, signal in STEMS:
    peak = float(np.max(np.abs(signal)))
    # -3 dBFS: leaves the mixer somewhere to go, and four stems summing to
    # exactly 0 dBFS would clip the moment anyone raises a fader.
    signal = signal / peak * 0.7079 if peak > 0 else signal
    pcm = (np.clip(signal, -1.0, 1.0) * 32767.0).astype("<i2")

    wav_path = out_dir / f"{name}.wav"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())

    mp3_path = out_dir / f"{name}.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    print(f"{mp3_path.name:14s} {mp3_path.stat().st_size / 1024:6.1f} KiB")

# The session document is emitted from the same run that renders the audio, so
# section markers land on real bar lines of the file that actually shipped.
# Hand-written timings drift the moment BPM or bar count changes here.
duration = total / SR
SECTIONS = [
    ("intro", "Intro", 0),
    ("verse", "Estrofa", 2),
    ("chorus", "Estribillo", 6),
    ("outro", "Final", 10),
]

song = {
    "version": 7,
    "id": "song_demo",
    "title": "Cancion de demostracion",
    "artist": "LibreTracks",
    "key": "G",
    "bpm": BPM,
    "timeSignature": "4/4",
    "durationSeconds": round(duration, 3),
    "tempoMarkers": [],
    "timeSignatureMarkers": [],
    "regions": [{
        "id": "region-demo",
        "name": "Cancion de demostracion",
        "startSeconds": 0.0,
        "endSeconds": round(duration, 3),
        "transposeSemitones": 0,
        "key": "G",
        "warpEnabled": False,
        "warpSourceBpm": None,
        "master": {"gain": 1.0},
    }],
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
        "color": color,
        "autoCreated": False,
        "collapsed": False,
    } for name, label, color, _signal in STEMS],
    "clips": [{
        "id": f"clip-{name}",
        "trackId": f"track-{name}",
        # Relative to the session folder, so the demo survives being copied
        # under whatever name the user's new session gets.
        "filePath": f"audio/{name}.mp3",
        "timelineStartSeconds": 0.0,
        "sourceStartSeconds": 0.0,
        "durationSeconds": round(duration, 3),
        "gain": 1.0,
        "fadeInSeconds": None,
        "fadeOutSeconds": None,
    } for name, _label, _color, _signal in STEMS],
    "midiClips": [],
    "sectionMarkers": [{
        "id": f"marker-{kind}",
        "name": label,
        "startSeconds": round(bar * BAR, 3),
        "digit": None,
        "kind": kind,
    } for kind, label, bar in SECTIONS],
}

session_path = demo_dir / "song.ltsession"
session_path.write_text(json.dumps(song, indent=2, ensure_ascii=True) + "\n",
                        encoding="utf-8")
print(f"{session_path.name:14s} {session_path.stat().st_size / 1024:6.1f} KiB")

print(f"\n{BARS} compases | {BPM:.0f} BPM | Sol mayor | {duration:.1f}s")
for kind, label, bar in SECTIONS:
    print(f"  compas {bar + 1:2d}  {bar * BAR:5.2f}s  {label} ({kind})")
print(f"salida: {demo_dir}")
