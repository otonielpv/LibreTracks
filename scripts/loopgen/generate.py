"""Kit «Básico» provisional y patrones de serie (plan drum-loops, paso 11).

Sonidos SINTETIZADOS aquí (sin muestras de terceros: sin licencia que
cumplir), hasta que la persona elija los definitivos (PENDIENTE-HUMANO).
Determinista: misma salida en cada ejecución (semilla fija).

    python scripts/loopgen/generate.py

Escribe en apps/desktop/src-tauri/resources/loops/builtin/:
  *.wav (16 bit mono 44,1 k, pico a -1 dBFS, sin silencio inicial),
  kit.json, patterns/*.json y LICENSE.txt.
"""

import json
import math
import random
import struct
from pathlib import Path

SR = 44100
PEAK = 10 ** (-1 / 20)  # -1 dBFS
OUT = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src-tauri" / "resources" / "loops" / "builtin"
rng = random.Random(20261117)


def noise(n):
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


def highpass(x, passes=1):
    for _ in range(passes):
        prev = 0.0
        out = []
        for v in x:
            out.append(v - prev)
            prev = v
        x = out
    return x


def lowpass(x, coeff):
    y = 0.0
    out = []
    for v in x:
        y += coeff * (v - y)
        out.append(y)
    return out


def env(n, decay, attack=0.0):
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        t = i / SR
        att = min(1.0, (i + 1) / a) if attack > 0 else 1.0
        out.append(att * math.exp(-t / decay))
    return out


def mix(*parts):
    n = max(len(p) for p in parts)
    return [sum(p[i] if i < len(p) else 0.0 for p in parts) for i in range(n)]


def mul(x, e):
    return [a * b for a, b in zip(x, e)]


def sine_sweep(n, f0, f1, k):
    phase = 0.0
    out = []
    for i in range(n):
        t = i / SR
        f = f1 + (f0 - f1) * math.exp(-t / k)
        phase += 2 * math.pi * f / SR
        out.append(math.sin(phase))
    return out


def tone(n, freq):
    return [math.sin(2 * math.pi * freq * i / SR) for i in range(n)]


def secs(s):
    return int(s * SR)


def kick():
    n = secs(0.42)
    body = mul(sine_sweep(n, 160, 45, 0.04), env(n, 0.16))
    click = mul(highpass(noise(secs(0.006))), env(secs(0.006), 0.002))
    return mix(body, [0.4 * v for v in click])


def snare():
    n = secs(0.25)
    body = mul(mix(tone(n, 185), [0.5 * v for v in tone(n, 330)]), env(n, 0.05))
    rattle = mul(highpass(noise(n)), env(n, 0.09))
    return mix([0.7 * v for v in body], rattle)


def rim():
    n = secs(0.05)
    return mix(mul(tone(n, 820), env(n, 0.008)), [0.5 * v for v in mul(highpass(noise(n)), env(n, 0.004))])


def hat(decay, length):
    n = secs(length)
    return mul(highpass(noise(n), 2), env(n, decay))


def shaker(length, attack, decay, bright):
    n = secs(length)
    x = highpass(noise(n), bright)
    return mul(x, env(n, decay, attack))


def tambourine():
    n = secs(0.3)
    jingles = mix(*[mul(tone(n, f), env(n, 0.06 + 0.02 * i)) for i, f in enumerate((5200, 6600, 7900, 9100))])
    return mix([0.35 * v for v in jingles], mul(highpass(noise(n), 2), env(n, 0.07)))


def clap():
    n = secs(0.22)
    out = [0.0] * n
    for k, start in enumerate((0, secs(0.009), secs(0.019))):
        burst = mul(lowpass(highpass(noise(secs(0.012))), 0.5), env(secs(0.012), 0.004))
        for i, v in enumerate(burst):
            out[start + i] += v * (1.0 - 0.15 * k)
    tail = mul(lowpass(highpass(noise(n)), 0.45), env(n, 0.06))
    start = secs(0.02)
    for i in range(n - start):
        out[start + i] += 0.6 * tail[i]
    return out


def cajon():
    n = secs(0.3)
    body = mul(sine_sweep(n, 120, 80, 0.03), env(n, 0.09))
    slap = mul(lowpass(highpass(noise(n)), 0.35), env(n, 0.03))
    return mix(body, [0.5 * v for v in slap])


def ride_bell():
    n = secs(0.9)
    partials = ((540, 1.0, 0.45), (1380, 0.6, 0.3), (2270, 0.45, 0.22), (3610, 0.3, 0.15))
    return mix(*[[a * v for v in mul(tone(n, f), env(n, d))] for f, a, d in partials])


SOUNDS = [
    # id, nombre, color, generador, grupo de corte
    ("kick", "Bombo", "#ff6b6b", kick, None),
    ("snare", "Caja", "#ffa94d", snare, None),
    ("rim", "Aro", "#ffd43b", rim, None),
    ("hat_closed", "Hi-hat cerrado", "#69db7c", lambda: hat(0.025, 0.08), 1),
    ("hat_open", "Hi-hat abierto", "#38d9a9", lambda: hat(0.16, 0.45), 1),
    ("shaker_a", "Shaker", "#4dabf7", lambda: shaker(0.13, 0.012, 0.035, 2), None),
    ("shaker_b", "Shaker suave", "#74c0fc", lambda: shaker(0.09, 0.006, 0.02, 1), None),
    ("tambourine", "Pandereta", "#9775fa", tambourine, None),
    ("clap", "Palmas", "#f783ac", clap, None),
    ("cajon", "Cajón", "#e599f7", cajon, None),
    ("ride_bell", "Campana ride", "#ced4da", ride_bell, None),
]


def finish(samples):
    # Sin silencio inicial: el primer sample audible es el 0.
    start = next((i for i, v in enumerate(samples) if abs(v) > 1e-4), 0)
    samples = samples[start:]
    peak = max(abs(v) for v in samples) or 1.0
    scale = PEAK / peak
    # Cola: fundido de 3 ms para no acabar en seco.
    fade = secs(0.003)
    out = []
    for i, v in enumerate(samples):
        g = scale * (min(1.0, (len(samples) - i) / fade))
        out.append(max(-32768, min(32767, int(round(v * g * 32767)))))
    return out


def write_wav(path, pcm):
    data = struct.pack("<%dh" % len(pcm), *pcm)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


def steps(text):
    return [{".": 0, "o": 1, "x": 2, "X": 3}[c] for c in text.replace(" ", "")]


def pattern(pid, name, bpm, rows, numerator=4, denominator=4, spb=4, bars=1, swing=0.0):
    count = numerator * spb * bars
    out_rows = []
    for sound_id, variations in rows:
        vs = [steps(v) for v in variations]
        assert len(vs) == 4, (pid, sound_id)
        for v in vs:
            assert len(v) == count, (pid, sound_id, len(v), count)
        out_rows.append({"soundId": sound_id, "gainDb": 0.0, "variations": vs})
    return {
        "id": pid,
        "name": name,
        "kit": {"kind": "library", "kitId": "basic"},
        "bpm": float(bpm),
        "signature": {"numerator": numerator, "denominator": denominator},
        "stepsPerBeat": spb,
        "bars": bars,
        "swing": swing,
        "rows": out_rows,
    }


E = "." * 16

PATTERNS = [
    pattern("builtin-shaker-16", "Shaker semicorcheas", 100, [
        ("shaker_a", ["x.o.x.o.x.o.x.o.", "xoxoxoxoxoxoxoxo", "XoxoXoxoXoxoXoxo", "XoxoXoxoXoxoXoxX"]),
        ("shaker_b", [E, E, "..o...o...o...o.", "o.o.o.o.o.o.o.o."]),
    ]),
    pattern("builtin-tambourine-24", "Pandereta en 2 y 4", 90, [
        ("tambourine", ["....x.......x...", "....X.......X...", "..o.X...o.o.X...", "..o.X.o.o.o.X.o."]),
        ("shaker_b", [E, "o.o.o.o.o.o.o.o.", "o.o.o.o.o.o.o.o.", "oooooooooooooooo"]),
    ]),
    pattern("builtin-hat-8", "Hi-hat en corcheas", 110, [
        ("hat_closed", ["x.x.x.x.x.x.x.x.", "X.x.X.x.X.x.X.x.", "X.xoX.xoX.xoX.xo", "XoxoXoxoXoxoXo.."]),
        ("hat_open", [E, E, E, "..............x."]),
    ]),
    pattern("builtin-pop", "Pop", 104, [
        ("kick", ["x.......x.......", "x.......x.x.....", "x..x....x.x.....", "x..x..x.x.x...x."]),
        ("snare", ["....x.......x...", "....x.......x...", "....x.......x..o", "....X.......X.o."]),
        ("hat_closed", ["x.x.x.x.x.x.x.x.", "xoxoxoxoxoxoxoxo", "xoxoxoxoxoxoxoxo", "XoxoXoxoXoxoXo.."]),
        ("hat_open", [E, E, E, "..............x."]),
    ]),
    pattern("builtin-ballad", "Balada", 72, [
        ("kick", ["x.......x.......", "x.....x.x.......", "x.....x.x...o...", "x..o..x.x...o..."]),
        ("rim", ["....x.......x...", "....x.......x...", "....x.......x...", "....x.......x..o"]),
        ("shaker_b", ["o...o...o...o...", "o.o.o.o.o.o.o.o.", "o.o.o.o.o.o.o.o.", "ooooooooooooooo."]),
        ("ride_bell", [E, E, "x.......x.......", "x...x...x...x..."]),
    ]),
    pattern("builtin-four-floor", "Four on the floor", 122, [
        ("kick", ["x...x...x...x...", "x...x...x...x...", "x...x...x...x...", "X...x...X...x..."]),
        ("clap", [E, "....x.......x...", "....x.......x...", "....x.......x..o"]),
        ("hat_open", ["..x...x...x...x.", "..x...x...x...x.", "..x...x...x...x.", "..X...X...X...X."]),
        ("hat_closed", [E, E, "x.o.x.o.x.o.x.o.", "xoxoxoxoxoxoxoxo"]),
    ]),
    pattern("builtin-rock", "Rock", 120, [
        ("kick", ["x.......x.......", "x.......x.x.....", "x.x.....x.x.....", "x.x...x.x.x...x."]),
        ("snare", ["....x.......x...", "....x.......x...", "....x.......x...", "....X.......X.oo"]),
        ("hat_closed", ["x.x.x.x.x.x.x.x.", "X.x.X.x.X.x.X.x.", "XoxoXoxoXoxoXoxo", "XoxoXoxoXoxoXo.."]),
        ("hat_open", [E, E, E, "..x...x...x...x."]),
    ]),
    pattern("builtin-worship-68", "Worship 6/8", 66, [
        ("kick", ["x.................", "x........x........", "x........x.....o..", "x.....o..x.....o.."]),
        ("rim", [".........x........", ".........x........", ".........x........", ".........X........"]),
        ("shaker_a", ["x..o..o..x..o..o..", "x..o..o..x..o..o..", "x.ox.ox.ox.ox.ox.o", "XoxXoxXoxXoxXoxXox"]),
        ("tambourine", ["." * 18, "." * 18, ".........o........", "...o.....o.....o.."]),
    ], numerator=6, denominator=8, spb=3),
    pattern("builtin-waltz-34", "Vals 3/4", 96, [
        ("kick", ["x...........", "x...........", "x.......o...", "x...o...o..."]),
        ("rim", ["....x...x...", "....x...x...", "....x...x...", "....x...x..o"]),
        ("shaker_b", ["." * 12, "o.o.o.o.o.o.", "o.o.o.o.o.o.", "oooooooooooo"]),
        ("ride_bell", ["." * 12, "." * 12, "x...........", "x...x...x..."]),
    ], numerator=3, denominator=4),
    pattern("builtin-shuffle", "Shuffle", 92, [
        ("kick", ["x.....x.....", "x.....x..x..", "x..o..x..x..", "x..o..x..x.o"]),
        ("snare", ["...x.....x..", "...x.....x..", "...x.....x..", "...X..o..X.o"]),
        ("hat_closed", ["x.xx.xx.xx.x", "x.xx.xx.xx.x", "X.xX.xX.xX.x", "X.xX.xX.xX.x"]),
        ("hat_open", ["." * 12, "." * 12, "." * 12, "..........x."]),
    ], spb=3),
    pattern("builtin-dembow", "Dembow", 92, [
        ("kick", ["x...x...x...x...", "x...x...x...x...", "x...x...x...x...", "X...x...X...x..."]),
        ("snare", ["...x..x....x..x.", "...x..x....x..x.", "...x..x.o..x..x.", "...X..x.o..X..xo"]),
        ("hat_closed", [E, "x.x.x.x.x.x.x.x.", "x.x.x.x.x.x.x.x.", "xoxoxoxoxoxoxoxo"]),
        ("shaker_a", [E, E, "oooooooooooooooo", "oooooooooooooooo"]),
    ]),
    pattern("builtin-cajon-pop", "Cajón flamenco-pop", 98, [
        ("cajon", ["x.....x.x.......", "x.....x.x...o...", "x..o..x.x...o...", "x..o..x.x..oo.o."]),
        ("clap", ["....x.......x...", "....x.......x...", "....x..o....x...", "..o.x..o..o.x..o"]),
        ("shaker_a", [E, "x.o.x.o.x.o.x.o.", "x.o.x.o.x.o.x.o.", "xoxoxoxoxoxoxoxo"]),
        ("tambourine", [E, E, E, "....x.......x..."]),
    ]),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "patterns").mkdir(exist_ok=True)
    sounds = []
    total = 0
    for sid, name, color, gen, choke in SOUNDS:
        pcm = finish(gen())
        path = OUT / f"{sid}.wav"
        write_wav(path, pcm)
        total += path.stat().st_size
        sound = {"id": sid, "name": name, "color": color, "sample": {"source": {"kind": "builtin"}, "file": f"{sid}.wav"}, "gainDb": 0.0}
        if choke:
            sound["chokeGroup"] = choke
        sounds.append(sound)
    by_id = {s["id"]: s for s in sounds}
    kits = [
        {"id": "basic", "name": "Básico", "sounds": [by_id[i] for i in
            ("kick", "snare", "rim", "hat_closed", "hat_open", "shaker_a", "tambourine", "clap")]},
        {"id": "percussion", "name": "Percusión", "sounds": [by_id[i] for i in
            ("kick", "rim", "shaker_a", "shaker_b", "tambourine", "clap", "cajon", "ride_bell")]},
    ]
    (OUT / "kit.json").write_text(json.dumps(kits, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for p in PATTERNS:
        used = {r["soundId"] for r in p["rows"]}
        kit = next((k for k in kits if used <= {s["id"] for s in k["sounds"]}), None)
        assert kit is not None, p["id"]
        p["kit"] = {"kind": "library", "kitId": kit["id"]}
        (OUT / "patterns" / f"{p['id']}.json").write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT / "LICENSE.txt").write_text(
        "Kit «Básico» provisional de LibreTracks (plan drum-loops, paso 11).\n"
        "Todos los sonidos se sintetizan con scripts/loopgen/generate.py: no contienen\n"
        "muestras de terceros. Se publican bajo CC0 1.0 (dominio público).\n"
        "https://creativecommons.org/publicdomain/zero/1.0/\n",
        encoding="utf-8",
    )
    print(f"{len(SOUNDS)} sounds, {total} bytes, {len(PATTERNS)} patterns -> {OUT}")


if __name__ == "__main__":
    main()
