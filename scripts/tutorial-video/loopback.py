"""Records what the default speaker is playing (WASAPI loopback) for the
tutorial video's playback moments, so the click, the voice guide and the song
are heard in the video.

    python loopback.py <out.wav> <seconds>

Prints one line, `START <epoch seconds>`, the instant the first block is
captured: the recording spec aligns the audio to its frames with it.
Needs: pip install soundcard numpy
"""
import sys
import time
import wave

import numpy as np
import soundcard as sc

out, seconds = sys.argv[1], float(sys.argv[2])
RATE = 48000
BLOCK = 1024

speaker = sc.default_speaker()
mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
chunks = []
with mic.recorder(samplerate=RATE, channels=2, blocksize=BLOCK) as rec:
    first = rec.record(numframes=BLOCK)
    # The block just returned ends now: its first sample was BLOCK/RATE ago.
    start = time.time() - BLOCK / RATE
    print(f"START {start:.4f}", flush=True)
    chunks.append(first)
    total = int(seconds * RATE)
    got = BLOCK
    while got < total:
        data = rec.record(numframes=BLOCK)
        chunks.append(data)
        got += len(data)

audio = np.concatenate(chunks)[:total]
pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(pcm.tobytes())
print(f"DONE {out}", flush=True)
