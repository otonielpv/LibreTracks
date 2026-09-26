#!/usr/bin/env node
// Genera los vídeos de prueba del plan de salida de vídeo
// (docs/plans/video-output, pasos 01, 04, 07 y 08). No se suben al repo: se
// regeneran con el ffmpeg del sistema cuando hacen falta.
//
//   node scripts/video-fixtures.mjs [carpeta]      (por defecto target/video-fixtures)
//   node scripts/video-fixtures.mjs [carpeta] --long   añade el de 11 min del seguimiento de reloj
//
// Requiere un ffmpeg con libx264, libx265, prores_ks y libvpx-vp9.
//
// El nombre no empieza por "build": el `build*` del .gitignore raíz se
// tragaría el script y la CI no lo vería en un clon limpio.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "target/video-fixtures");
const includeLong = args.includes("--long");
mkdirSync(outDir, { recursive: true });

// Fondo con número de fotograma impreso: a ojo se ve si un seek cayó donde debía.
const testCard = (size, rate, seconds) =>
  ["-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=${seconds}`];

// Destello blanco de un fotograma y bip de 1 kHz en el mismo instante, cada
// segundo: el patrón con el que se mide a cámara lenta el desfase imagen/sonido.
const flashAndBeep = (seconds) => [
  "-f", "lavfi", "-i", `color=c=black:size=1920x1080:rate=30:duration=${seconds}`,
  "-f", "lavfi", "-i",
  `aevalsrc='if(lt(mod(t\\,1)\\,0.03)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=${seconds}`,
  "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t\\,1)\\,0.033)'",
];

const x264 = (gopFrames) => [
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
  "-g", String(gopFrames), "-keyint_min", String(gopFrames), "-sc_threshold", "0",
];

const fixtures = [
  { name: "h264-gop10s-1080p30.mp4", args: [...testCard("1920x1080", 30, 60), ...x264(300)] },
  { name: "h264-gop1s-1080p30.mp4", args: [...testCard("1920x1080", 30, 60), ...x264(30)] },
  {
    name: "hevc-1080p30.mp4",
    args: [
      ...testCard("1920x1080", 30, 60),
      "-c:v", "libx265", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
      "-x265-params", "keyint=60:min-keyint=60:log-level=error",
    ],
  },
  {
    name: "prores422-1080p30.mov",
    args: [...testCard("1920x1080", 30, 20), "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"],
  },
  {
    name: "vp9-1080p30.webm",
    args: [
      ...testCard("1920x1080", 30, 30),
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
      "-b:v", "4M", "-g", "60",
    ],
  },
  { name: "h264-4k60.mp4", args: [...testCard("3840x2160", 60, 20), ...x264(60)] },
  {
    name: "flash-beep-gop1s.mp4",
    args: [...flashAndBeep(60), ...x264(30), "-c:a", "aac", "-b:a", "128k", "-shortest"],
  },
  {
    name: "flash-beep-gop10s.mp4",
    args: [...flashAndBeep(60), ...x264(300), "-c:a", "aac", "-b:a", "128k", "-shortest"],
  },
];

if (includeLong) {
  fixtures.push({
    name: "h264-gop1s-1080p30-11min.mp4",
    args: [...testCard("1920x1080", 30, 660), ...x264(30), "-preset", "ultrafast"],
  });
}

let failed = false;
for (const fixture of fixtures) {
  const target = join(outDir, fixture.name);
  if (existsSync(target)) {
    console.log(`= ${fixture.name} (ya existe)`);
    continue;
  }
  console.log(`+ ${fixture.name}`);
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...fixture.args, target], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`  falló (${result.status ?? result.error})`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
