// Narration for a tutorial video: one MP3 (and subtitle file) per scene,
// plus durations.json, which the recording spec reads so each scene on screen
// lasts at least as long as its sentence.
//
//   node scripts/tutorial-video/tts.mjs scripts/tutorial-video/primeros-pasos.es.json <outDir>
//
// Uses Microsoft's neural voices through `edge-tts` (pip install edge-tts):
// only the script text is sent to the service.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , scriptPath, outDir] = process.argv;
if (!scriptPath || !outDir) {
  console.error("usage: tts.mjs <script.json> <outDir>");
  process.exit(1);
}
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const durations = {};
for (const scene of script.scenes) {
  const mp3 = path.join(outDir, `${scene.id}.mp3`);
  const srt = path.join(outDir, `${scene.id}.srt`);
  execFileSync(
    "python",
    [
      "-m",
      "edge_tts",
      "--voice",
      script.voice,
      `--rate=${script.rate ?? "+0%"}`,
      "--text",
      scene.text,
      "--write-media",
      mp3,
      "--write-subtitles",
      srt,
    ],
    { stdio: "inherit" },
  );
  const seconds = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3])
      .toString()
      .trim(),
  );
  durations[scene.id] = seconds;
  console.log(`${scene.id}: ${seconds.toFixed(2)} s`);
}
writeFileSync(path.join(outDir, "durations.json"), JSON.stringify(durations, null, 2));
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`total narration: ${total.toFixed(1)} s`);
