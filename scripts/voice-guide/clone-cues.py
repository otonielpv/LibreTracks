"""Clone the voice guide's voice for new cues with F5-TTS (as for a0503522).

The reference is several of the pack's own cues joined (a half-second clip
alone clones badly). Spanish uses the F5-Spanish fine-tune; English the base
F5TTS_v1 model. Several seeds per text: pick-cue-takes.py keeps the take Whisper
hears exactly, and conform-cue.mjs brings it to the pack's format and loudness.

Environment (CPU is enough for a few short clips). These pins are the ones that
work together on Windows: newer torchaudio needs torchcodec + FFmpeg DLLs, and
newer transformers/datasets need newer torch/huggingface_hub.

    uv venv f5env --python 3.12
    uv pip install --python f5env/Scripts/python.exe torch==2.5.1 torchaudio==2.5.1         --index-url https://download.pytorch.org/whl/cpu
    uv pip install --python f5env/Scripts/python.exe f5-tts faster-whisper         transformers==4.46.3 datasets==3.1.0 soundfile
    uv pip uninstall --python f5env/Scripts/python.exe torchcodec

    HF_HUB_OFFLINE=1 f5env/Scripts/python.exe -I clone-cues.py <voices dir> <out dir>

Edit `jobs` below for the cues to generate (here: the tempo cues).
"""
import glob
import os
import subprocess
import sys

from f5_tts.api import F5TTS

voices, out = sys.argv[1], sys.argv[2]
HF = os.path.expanduser("~/.cache/huggingface/hub")

def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

def build_ref(lang, names, path):
    """Concatenate pack cues (silence trimmed, 0.35 s apart) into one reference."""
    inputs, parts = [], []
    for index, name in enumerate(names):
        inputs += ["-i", f"{voices}/{lang}/cues/{name}.wav"]
        parts.append(
            f"[{index}:a]aresample=24000,aformat=channel_layouts=mono,"
            f"silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-50dB,"
            f"apad=pad_dur=0.35[a{index}]"
        )
    concat = "".join(f"[a{i}]" for i in range(len(names)))
    graph = ";".join(parts) + f";{concat}concat=n={len(names)}:v=0:a=1[out]"
    ffmpeg(*inputs, "-filter_complex", graph, "-map", "[out]", path)

jobs = {
    "es": {
        "ref": ["key_change_up", "key_change_down", "build", "ease_down"],
        "ref_text": "Sube tono. Baja tono. Subir intensidad. Bajar intensidad.",
        "texts": {"tempo_up": "Sube tempo.", "tempo_down": "Baja tempo."},
        "model": dict(
            model="F5TTS_Base",
            ckpt_file=glob.glob(f"{HF}/models--jpgallegoar--F5-Spanish/snapshots/*/model_1250000.safetensors")[0],
            vocab_file=glob.glob(f"{HF}/models--jpgallegoar--F5-Spanish/snapshots/*/vocab.txt")[0],
        ),
    },
    "en": {
        "ref": ["key_change_up", "key_change_down", "slowly_build", "get_ready"],
        "ref_text": "Key change up. Key change down. Slowly build. Get ready.",
        "texts": {"tempo_up": "Speed up.", "tempo_down": "Slow down."},
        "model": dict(model="F5TTS_v1_Base"),
    },
}

for lang, job in jobs.items():
    ref = f"{out}/ref_{lang}.wav"
    build_ref(lang, job["ref"], ref)
    tts = F5TTS(device="cpu", **job["model"])
    for kind, text in job["texts"].items():
        for seed in (1, 2, 3, 4):
            target = f"{out}/{lang}_{kind}_{seed}.wav"
            tts.infer(ref, job["ref_text"], text, file_wave=target, seed=seed,
                      remove_silence=True, show_info=lambda *a, **k: None)
            print("generated", target, flush=True)
