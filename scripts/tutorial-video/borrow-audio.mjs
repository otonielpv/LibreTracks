// The phone tutorial's playback moments, heard with the desktop tutorial's
// recordings of the same thing.
//
// The Android emulator runs the ARM build through translation, and its audio
// reaches the PC far too quiet and unreliable to use (measured: about -56 dB
// against -6 to -13 dB on the desktop). The moments are the SAME content in
// both videos — the same stems at 128 BPM with the click, the voice guide
// announcing the chorus, the Live view jumping to it — so each phone clip is
// replaced by its desktop twin, trimmed to the phone clip's length, keeping
// the instant the phone pressed play (<id>.audio.json).
//
//   node scripts/tutorial-video/borrow-audio.mjs <phone scenes dir> <desktop scenes dir>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const [, , phoneDir, desktopDir] = process.argv;
if (!phoneDir || !desktopDir) {
  console.error("usage: borrow-audio.mjs <phone scenes dir> <desktop scenes dir>");
  process.exit(1);
}

/** Phone scene → desktop clips, in the order the phone scene plays them. */
const TWINS = {
  "07-tempo": ["08-tempo.audio-0.wav"],
  "10-guia": ["14-guia.audio-0.wav"],
  "11-live": ["16-live.audio-0.wav", "16-live.audio-1.wav"],
};

const probe = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

for (const [scene, twins] of Object.entries(TWINS)) {
  const meta = path.join(phoneDir, `${scene}.audio.json`);
  if (!existsSync(meta)) {
    console.log(`${scene}: no audio moments recorded, skipped`);
    continue;
  }
  const clips = JSON.parse(readFileSync(meta, "utf8"));
  if (clips.length !== twins.length) throw new Error(`${scene}: ${clips.length} moments, ${twins.length} twins`);
  clips.forEach((clip, i) => {
    const target = path.join(phoneDir, clip.wav);
    const length = probe(target);
    const source = path.join(desktopDir, twins[i]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", source, "-t", length.toFixed(3), "-ar", "48000", "-ac", "2", target]);
    console.log(`${scene}: ${clip.wav} <- ${twins[i]} (${length.toFixed(2)} s)`);
  });
}
