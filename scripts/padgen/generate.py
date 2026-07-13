"""Generate LibreTracks ambient-pad packs from Surge XT factory presets.

Each pack renders the 12 keys as seamless ~2 min loops (the engine's
pad_renderer wraps with position % clip_frames + a 20 ms seam crossfade, so
short seamless files play forever), encodes FLAC (decoded by dr_flac in the
engine), zips the keys at the archive root, and prints a manifest.json entry
with size + sha256 filled in.

The renders are not frozen chords: a fixed low drone holds the key while the
upper voices rotate through diatonic chord colors every SECTION seconds and a
soft top line drifts above them. The pattern period divides LOOP, so the loop
seam stays invisible.

Requires: Surge XT installed (winget install SurgeSynth.SurgeXT),
pip install pedalboard soundfile numpy mido.

Usage: python generate.py [out_dir]
"""
import hashlib
import json
import os
import sys
import zipfile

import numpy as np
import pedalboard
import soundfile as sf
from mido import Message

from juce_state import juce_state_trailer, make_vstpreset, read_fxp_chunk

VST = r"C:\Program Files\Common Files\VST3\Surge Synth Team\Surge XT.vst3\Contents\x86_64-win\Surge XT.vst3"
PATCH_DIR = r"C:\ProgramData\Surge XT\patches_factory\Pads"

SR = 44100
LEAD = 10.0       # attack/swell seconds discarded from the render head
LOOP = 120.0      # loop body seconds (per-key RAM at load: ~42 MB as f32 stereo)
XFADE = 6.0       # equal-power crossfade folded from tail into head
SECTION = 15.0    # seconds per chord-color section
RMS_TARGET_DB = -20.0
PEAK_CEIL_DB = -1.5

# Filesystem-safe key stems, C..B — must match KEY_STEMS in pads.rs.
KEY_STEMS = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"]

# Register per pack style: drone notes + semitone shift for the moving voices.
STYLES = {
    "std":     {"drone": [36, 48, 55], "shift": 0},    # C2 C3 G3
    "shimmer": {"drone": [48, 55, 60], "shift": 12},   # C3 G3 C4, voces +8va
    "deep":    {"drone": [36, 43, 48], "shift": -12},  # C2 G2 C3, voces -8va
}

# 8 sections x 15 s = one 120 s cycle. Diatonic colors over the tonic drone
# (maj9 / add6 / maj7 vocabulary), offsets relative to C4 = 60.
SECTIONS = [
    {"chord": [64, 67, 72], "top": 76},  # E G C   + E5
    {"chord": [62, 67, 71], "top": 74},  # D G B   + D5 (maj9)
    {"chord": [64, 69, 72], "top": 72},  # E A C   + C5 (add6)
    {"chord": [67, 71, 74], "top": 79},  # G B D   + G5 (maj9 alto)
    {"chord": [64, 67, 74], "top": 72},  # E G D   + C5 (add9)
    {"chord": [60, 67, 71], "top": 76},  # C G B   + E5 (maj7)
    {"chord": [62, 69, 72], "top": 74},  # D A C   + D5 (sus/6 color)
    {"chord": [64, 67, 72], "top": 79},  # E G C   + G5 (vuelta a casa)
]
OVERLAP_IN = 2.0
RELEASE_TAIL = 3.0
CHORD_VEL, TOP_VEL = 72, 58

PACKS = [
    {"id": "still", "name": "Still", "preset": "Still", "style": "std",
     "description": "Pad suave y sereno con movimiento lento, ideal para momentos de calma."},
    {"id": "warm-mks70", "name": "Warm MKS-70", "preset": "MKS-70 Warm Pad", "style": "std",
     "description": "Pad calido estilo Roland MKS-70, redondo y envolvente."},
    {"id": "bells", "name": "Bells", "preset": "Bell Pad", "style": "shimmer",
     "description": "Campanas etereas en registro agudo, brillo delicado."},
    {"id": "distant", "name": "Distant", "preset": "Distant", "style": "deep",
     "description": "Pad lejano y profundo, textura amplia en registro grave."},
    {"id": "endgame", "name": "Endgame", "preset": "Endgame", "style": "deep",
     "description": "Pad oscuro y denso, fundamento grave con caracter."},
    {"id": "retro-choir", "name": "Retro Choir", "preset": "Retro Choir", "style": "std",
     "description": "Coro sintetico vintage, calido con aire vocal."},
]


def key_offset(k: int) -> int:
    """Transpose keys above F# down an octave to keep the register comparable."""
    return k if k <= 6 else k - 12


def build_midi(total_seconds: float, style: str, semitones: int):
    st = STYLES[style]
    events = []
    for n in st["drone"]:
        events.append(Message("note_on", note=n + semitones, velocity=84, time=0.0))
        events.append(Message("note_off", note=n + semitones, time=total_seconds - 0.01))

    # Section cycles start at t=LEAD and repeat every LOOP seconds, so the
    # audio in [LEAD, LEAD+LOOP) matches [LEAD+LOOP, ...) at the seam.
    t = LEAD
    while t < total_seconds:
        for si, sec in enumerate(SECTIONS):
            start = t + si * SECTION - OVERLAP_IN
            end = t + (si + 1) * SECTION + RELEASE_TAIL
            if start >= total_seconds:
                continue
            end = min(end, total_seconds - 0.01)
            for n in sec["chord"]:
                note = n + st["shift"] + semitones
                events.append(Message("note_on", note=note, velocity=CHORD_VEL, time=max(start, 0.0)))
                events.append(Message("note_off", note=note, time=end))
            ts, te = start + 4.0, min(end - 2.0, total_seconds - 0.01)
            if ts < te:
                note = sec["top"] + st["shift"] + semitones
                events.append(Message("note_on", note=note, velocity=TOP_VEL, time=ts))
                events.append(Message("note_off", note=note, time=te))
        t += LOOP
    return sorted(events, key=lambda m: m.time)


def make_loop(audio: np.ndarray) -> np.ndarray:
    lead, loop_n, xf = int(LEAD * SR), int(LOOP * SR), int(XFADE * SR)
    seg = audio[:, lead : lead + loop_n + xf]
    body = seg[:, :loop_n].copy()
    tail = seg[:, loop_n : loop_n + xf]
    t = np.linspace(0.0, 1.0, xf, dtype=np.float32)
    body[:, :xf] = body[:, :xf] * np.sqrt(t) + tail * np.sqrt(1.0 - t)
    return body


def normalize(audio: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(audio**2)))
    gain = 10 ** (RMS_TARGET_DB / 20) / max(rms, 1e-9)
    peak = float(np.max(np.abs(audio))) * gain
    ceil = 10 ** (PEAK_CEIL_DB / 20)
    if peak > ceil:
        gain *= ceil / peak
    return audio * gain


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    out_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "pads-out")
    os.makedirs(out_dir, exist_ok=True)

    plugin = pedalboard.load_plugin(VST)
    trailer = juce_state_trailer(plugin)
    manifest = []
    total_seconds = LEAD + LOOP + XFADE + 1.0

    for pack in PACKS:
        chunk = read_fxp_chunk(os.path.join(PATCH_DIR, f"{pack['preset']}.fxp"))
        preset_path = os.path.join(out_dir, "_tmp.vstpreset")
        open(preset_path, "wb").write(make_vstpreset(chunk + trailer))
        plugin.load_preset(preset_path)
        # Surge applies the new state on the first process() — warm-up render.
        plugin([Message("note_on", note=60, time=0.0),
                Message("note_off", note=60, time=0.5)],
               duration=1.0, sample_rate=SR)

        pack_dir = os.path.join(out_dir, pack["id"])
        os.makedirs(pack_dir, exist_ok=True)
        for k, stem in enumerate(KEY_STEMS):
            midi = build_midi(total_seconds, pack["style"], key_offset(k))
            audio = plugin(midi, duration=total_seconds, sample_rate=SR)
            rms = float(np.sqrt(np.mean(audio**2)))
            if rms < 1e-5:
                raise RuntimeError(f"{pack['id']}/{stem}: silent render — preset did not load?")
            looped = normalize(make_loop(audio))
            flac_path = os.path.join(pack_dir, f"{stem}.flac")
            sf.write(flac_path, looped.T, SR, subtype="PCM_16")
            print(f"{pack['id']}/{stem}: rms={rms:.4f}", flush=True)

        zip_path = os.path.join(out_dir, f"{pack['id']}.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
            for stem in KEY_STEMS:
                z.write(os.path.join(pack_dir, f"{stem}.flac"), f"{stem}.flac")
        os.remove(preset_path)

        manifest.append({
            "id": pack["id"],
            "name": pack["name"],
            "description": pack["description"],
            "sizeBytes": os.path.getsize(zip_path),
            "downloadUrl": f"https://github.com/otonielpv/libretracks-pads/releases/download/vX.Y/{pack['id']}.zip",
            "sha256": sha256_of(zip_path),
        })
        print(f"packed {zip_path} ({os.path.getsize(zip_path) / 1e6:.1f} MB)", flush=True)

    manifest_path = os.path.join(out_dir, "manifest-entries.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"pads": manifest}, f, indent=2, ensure_ascii=False)
    print(f"\nmanifest entries -> {manifest_path}")
    print(json.dumps({"pads": manifest}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
