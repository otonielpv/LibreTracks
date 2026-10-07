// Joins the recorded scenes with their narration into the final tutorial:
// each scene's video is held on its last frame if the sentence is longer,
// the voice starts 0.4 s in, subtitles are burnt in (and also written as an
// .srt for YouTube).
//
//   node scripts/tutorial-video/compose.mjs scripts/tutorial-video/primeros-pasos.es.json <tutorialDir> <out.mp4>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , scriptPath, dir, outFile] = process.argv;
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const narrationDir = path.join(dir, "narration");
const scenesDir = path.join(dir, "scenes");
const work = path.resolve(dir, "compose");
mkdirSync(work, { recursive: true });

const LEAD = 0.4; // seconds of picture before the voice starts
const TAIL = 0.6; // breath after the sentence
const probe = (file) =>
  Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );
const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });

// SRT helpers
const toSeconds = (t) => {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
};
const toStamp = (sec) => {
  const ms = Math.round(sec * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

const parts = [];
const cues = [];
let clock = 0;
for (const scene of script.scenes) {
  const video = [path.join(scenesDir, `${scene.id}.mp4`), path.join(scenesDir, `${scene.id}.raw.mp4`)].find(existsSync);
  if (!video) throw new Error(`no video for ${scene.id}`);
  const voice = path.join(narrationDir, `${scene.id}.mp3`);
  const voiceLen = probe(voice);
  const videoLen = probe(video);
  const len = Math.max(videoLen, LEAD + voiceLen + TAIL);
  const part = path.join(work, `${scene.id}.mp4`);
  ff([
    "-i", video,
    "-i", voice,
    "-filter_complex",
    `[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${(len - videoLen + 0.1).toFixed(2)}[v];` +
      `[1:a]adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad,aresample=48000[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", len.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    part,
  ]);
  const srt = path.join(narrationDir, `${scene.id}.srt`);
  for (const block of readFileSync(srt, "utf8").replace(/\r/g, "").trim().split(/\n\n+/)) {
    const lines = block.split("\n");
    const [a, b] = lines[1].split(" --> ");
    cues.push({ start: clock + LEAD + toSeconds(a), end: clock + LEAD + toSeconds(b), text: lines.slice(2).join("\n") });
  }
  parts.push(part);
  console.log(`${scene.id}: ${len.toFixed(1)} s`);
  clock += len;
}

const srtOut = outFile.replace(/\.mp4$/, ".srt");
writeFileSync(
  srtOut,
  cues.map((c, i) => `${i + 1}\n${toStamp(c.start)} --> ${toStamp(c.end)}\n${c.text}\n`).join("\n"),
);
const list = path.join(work, "list.txt");
writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
const joined = path.join(work, "joined.mp4");
ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);

// Burn the subtitles in. The subtitles filter wants a path relative to the
// working directory without a drive letter, so run ffmpeg from the srt's dir.
const style =
  "FontName=Inter,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
  "BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=28,Alignment=2";
execFileSync(
  "ffmpeg",
  [
    "-y", "-loglevel", "error",
    "-i", path.resolve(joined),
    "-vf", `subtitles=${path.basename(srtOut)}:force_style='${style}'`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart",
    path.resolve(outFile),
  ],
  { stdio: "inherit", cwd: path.dirname(path.resolve(srtOut)) },
);
console.log(`total: ${clock.toFixed(1)} s -> ${outFile}`);
