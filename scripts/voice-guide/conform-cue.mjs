#!/usr/bin/env node
// Conform a generated voice clip (scripts/voice-guide/clone-cues.py) to the
// voice pack and copy it in:
//
//   node scripts/voice-guide/conform-cue.mjs <take.wav> <es|en> <kind>
//
// Trims the silence around the voice, converts to the pack's format (44.1 kHz,
// 16-bit stereo, padded to the pack's 1.28 s when shorter) and brings the
// loudness, with clean gain, to the median LUFS of that language's cues — the
// criterion of 9b4ed2b1 (the two packs differ by ~4 dB and each must be
// consistent with itself). Requires ffmpeg in the PATH.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const voices = resolve(here, "../../apps/desktop/src-tauri/resources/voices");
const [take, lang, kind] = process.argv.slice(2);
if (!take || !lang || !kind) {
  console.error("usage: conform-cue.mjs <take.wav> <es|en> <kind>");
  process.exit(1);
}

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${result.stderr}`);
  return result.stderr;
}

function lufs(file) {
  const log = ffmpeg(["-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf("Summary")))[1]);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const cuesDir = join(voices, lang, "cues");
const target = median(
  readdirSync(cuesDir)
    .filter((name) => name.endsWith(".wav") && name !== `${kind}.wav`)
    .map((name) => lufs(join(cuesDir, name))),
);
const output = join(cuesDir, `${kind}.wav`);
const shape = (gainDb) =>
  [
    "silenceremove=start_periods=1:start_threshold=-50dB",
    "areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse",
    "aresample=44100",
    "aformat=sample_fmts=s16:channel_layouts=stereo",
    `volume=${gainDb.toFixed(2)}dB`,
    "apad=whole_dur=1.28",
  ].join(",");
ffmpeg(["-y", "-i", take, "-af", shape(0), "-c:a", "pcm_s16le", output]);
const gain = target - lufs(output);
ffmpeg(["-y", "-i", take, "-af", shape(gain), "-c:a", "pcm_s16le", output]);
console.log(`${lang}/cues/${kind}.wav  ${lufs(output).toFixed(2)} LUFS (pack ${target.toFixed(2)}, ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB)`);
