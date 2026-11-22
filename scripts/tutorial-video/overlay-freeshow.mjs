#!/usr/bin/env node
// Lays the FreeShow window capture (release-video.e2e.ts, scene 08 pass B)
// over the LibreTracks scene, lined up on the moment playback starts in each:
//
//   node scripts/tutorial-video/overlay-freeshow.mjs marketing/video-1.18.0
//
// Reads scenes/08-letra-directo.mp4, extra/08-freeshow.mp4 and
// extra/08-freeshow.json ({ sceneAt, grabAt }: seconds into each video where
// playback starts). Keeps the untouched scene as extra/08-letra-directo.base.mp4
// so it can be re-run. The scene's audio clips (its .audio.json) are not
// touched: the overlay does not move the scene's timeline.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "marketing/video-1.18.0");
const scene = path.join(dir, "scenes", "08-letra-directo.mp4");
const base = path.join(dir, "extra", "08-letra-directo.base.mp4");
const grab = path.join(dir, "extra", "08-freeshow.mp4");
const { sceneAt, grabAt } = JSON.parse(readFileSync(path.join(dir, "extra", "08-freeshow.json"), "utf8"));

if (!existsSync(base)) copyFileSync(scene, base);

// FreeShow frame time g shows what the scene shows at sceneAt + (g - grabAt).
const offset = sceneAt - grabAt;
const W = 1240; // overlay width on the 1920x1080 scene
const pad = 6;
const filter = [
  `[1:v]setpts=PTS-STARTPTS+${offset.toFixed(3)}/TB,scale=${W}:-2:flags=lanczos,` +
    `pad=iw+${pad * 2}:ih+${pad * 2}:${pad}:${pad}:color=0x2a2f36[fs]`,
  `[0:v][fs]overlay=x=W-w-36:y=H-h-36:eof_action=pass:enable='gte(t,${Math.max(0, offset).toFixed(3)})'[v]`,
].join(";");

execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", base, "-i", grab,
  "-filter_complex", filter, "-map", "[v]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  scene,
], { stdio: "inherit" });
console.log(`overlay-freeshow: ${path.relative(process.cwd(), scene)} (offset ${offset.toFixed(2)} s)`);
