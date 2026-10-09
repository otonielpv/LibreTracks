"""Transcribe every candidate and keep, per clip, the one Whisper hears exactly."""
import glob
import re
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

folder = sys.argv[1]
expected = {
    ("es", "tempo_up"): "sube tempo",
    ("es", "tempo_down"): "baja tempo",
    ("en", "tempo_up"): "speed up",
    ("en", "tempo_down"): "slow down",
}

def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000",
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def norm(text):
    return re.sub(r"[^a-záéíóúñ ]", "", text.lower()).strip()

model = WhisperModel("medium", device="cpu", compute_type="int8")
for (lang, kind), want in expected.items():
    best = None
    for path in sorted(glob.glob(f"{folder}/{lang}_{kind}_*.wav")):
        audio = load(path)
        segments, info = model.transcribe(audio, language=lang)
        heard = " ".join(s.text for s in segments)
        seconds = len(audio) / 16000
        ok = norm(heard) == want
        print(f"{lang} {kind} {path[-6:]} {seconds:.2f}s ok={ok} heard={heard!r}", flush=True)
        # Exact text first; then the shortest, the snappiest delivery.
        if ok and (best is None or seconds < best[1]):
            best = (path, seconds)
    print("PICK", lang, kind, best[0] if best else None, flush=True)
