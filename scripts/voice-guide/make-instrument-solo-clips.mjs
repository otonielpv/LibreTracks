#!/usr/bin/env node
// Genera los clips de voz guía «Solo batería / bajo / guitarra» (ES) y
// «Drums / Bass / Guitar solo» (EN) uniendo dos clips que el pack ya trae:
// la sección `solo` y el aviso del instrumento (`cues/<instrumento>.wav`).
//
//   node scripts/voice-guide/make-instrument-solo-clips.mjs
//
// Requiere ffmpeg en el PATH. Sobrescribe los ficheros de salida.
//
// Cómo se unen:
// - Se recorta la cola muda de cada clip (el pack los rellena hasta 1,28 s)
//   dejando un poco de caída natural, y se separan por un hueco corto: sin
//   recortar, el silencio del primero partía la frase en dos.
// - ES dice «Solo» + instrumento; EN dice instrumento + «solo».
// - Todo a 44,1 kHz, 16 bits estéreo, la conformación del pack.
// - Se mide la sonoridad (LUFS, ITU-R BS.1770) del resultado y se lleva con
//   ganancia limpia, sin limitador, a la mediana de las secciones de su propio
//   pack: el mismo criterio de 9b4ed2b1 (los dos packs difieren ~4 dB entre sí
//   y cada uno debe ser coherente consigo mismo).

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const voices = resolve(here, "../../apps/desktop/src-tauri/resources/voices");

/** Silencio entre las dos palabras, en segundos. */
const GAP_SECONDS = 0.08;
/** Caída que se conserva tras el final detectado de la voz. */
const TAIL_SECONDS = 0.04;
const SILENCE_DB = -50;

const INSTRUMENTS = [
  { kind: "drum_solo", cue: "drums" },
  { kind: "bass_solo", cue: "bass" },
  { kind: "guitar_solo", cue: "guitar" },
];

/** Ejecuta ffmpeg y devuelve su stderr, donde escribe los análisis. */
function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stderr;
}

function analyze(file, filter) {
  return ffmpeg(["-i", file, "-af", filter, "-f", "null", "-"]);
}

/** Fin de la voz: inicio del último silencio, si llega hasta el final. */
function speechEnd(file) {
  const log = analyze(file, `silencedetect=n=${SILENCE_DB}dB:d=0.05`);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const [h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(log).slice(1).map(Number);
  const last = starts.at(-1);
  return last !== undefined && last > 0.1 ? last : h * 3600 + m * 60 + s;
}

function integratedLufs(file) {
  const log = analyze(file, "ebur128=framelog=quiet");
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf("Summary")));
  if (!match) throw new Error(`no LUFS for ${file}`);
  return Number(match[1]);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function packSectionMedian(lang) {
  const dir = join(voices, lang, "sections");
  const ours = new Set(INSTRUMENTS.map(({ kind }) => `${kind}.wav`));
  return median(
    readdirSync(dir)
      .filter((name) => name.endsWith(".wav") && !ours.has(name))
      .map((name) => integratedLufs(join(dir, name))),
  );
}

function joinClips(first, second, output, gainDb) {
  const endA = speechEnd(first) + TAIL_SECONDS;
  const endB = speechEnd(second) + TAIL_SECONDS;
  const norm = "aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo";
  const graph = [
    `[0:a]${norm},atrim=0:${endA.toFixed(4)},afade=t=out:st=${(endA - 0.02).toFixed(4)}:d=0.02[a]`,
    `anullsrc=r=44100:cl=stereo,atrim=0:${GAP_SECONDS},${norm}[gap]`,
    `[1:a]${norm},atrim=0:${endB.toFixed(4)},afade=t=out:st=${(endB - 0.02).toFixed(4)}:d=0.02[b]`,
    `[a][gap][b]concat=n=3:v=0:a=1,volume=${gainDb.toFixed(2)}dB[out]`,
  ].join(";");
  ffmpeg([
    "-y",
    "-i", first,
    "-i", second,
    "-filter_complex", graph,
    "-map", "[out]",
    "-ar", "44100",
    "-ac", "2",
    "-c:a", "pcm_s16le",
    output,
  ]);
}

for (const lang of ["es", "en"]) {
  const target = packSectionMedian(lang);
  for (const { kind, cue } of INSTRUMENTS) {
    const solo = join(voices, lang, "sections", "solo.wav");
    const instrument = join(voices, lang, "cues", `${cue}.wav`);
    const [first, second] = lang === "es" ? [solo, instrument] : [instrument, solo];
    const output = join(voices, lang, "sections", `${kind}.wav`);
    joinClips(first, second, output, 0);
    const gain = target - integratedLufs(output);
    joinClips(first, second, output, gain);
    console.log(
      `${lang}/sections/${kind}.wav  ${integratedLufs(output).toFixed(2)} LUFS ` +
        `(pack ${target.toFixed(2)}, ganancia ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB)`,
    );
  }
}
