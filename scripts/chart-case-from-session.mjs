#!/usr/bin/env node
// A test case of the chart import from a real song of a session: its section
// markers, tempo and meter, plus the sheet as Planning Center has it.
//
//   node scripts/chart-case-from-session.mjs <session.ltsession> "<song name>" <sheet.txt> <case.json> [sheetKey] [songKey]
//
// The case goes to docs/plans/smart-chart-import/cases/ (outside git: real
// sheets have copyrighted lyrics) and `privateChartCases.test.ts` runs it.
// Add an "expect" list ([marker name, section label or null, passes]) by
// hand once the right answer is known.

import { readFileSync, writeFileSync } from "node:fs";

const [sessionPath, songName, sheetPath, outPath, sheetKey = null, songKeyArg] = process.argv.slice(2);
if (!sessionPath || !songName || !sheetPath || !outPath) {
  console.error('usage: chart-case-from-session.mjs <session> "<song name>" <sheet.txt> <case.json> [sheetKey] [songKey]');
  process.exit(1);
}

const session = JSON.parse(readFileSync(sessionPath, "utf8"));
const wanted = songName.toLowerCase();
const region = session.regions.find((candidate) => candidate.name.toLowerCase().includes(wanted));
if (!region) {
  console.error(`no song matching "${songName}". Songs: ${session.regions.map((candidate) => candidate.name).join(" | ")}`);
  process.exit(1);
}

const CUES = new Set([
  "ad_lib", "all_in", "bass", "big_ending", "break", "build", "drums_in", "drums", "guitar", "hits", "hold",
  "key_change_down", "key_change_up", "keys", "last_time", "slowly_build", "softly", "swell", "worship_freely",
  "ease_down", "get_ready", "tempo_up", "tempo_down", "count", "count_it", "silence", "loud", "here_we_go", "horns",
]);
const isSection = (marker) =>
  marker.categoryOverride === "section" || (marker.categoryOverride !== "cue" && !CUES.has(marker.kind ?? "custom"));

const markers = session.sectionMarkers
  .filter((marker) => marker.startSeconds >= region.startSeconds - 0.001 && marker.startSeconds < region.endSeconds)
  .filter(isSection)
  .sort((left, right) => left.startSeconds - right.startSeconds)
  .map((marker) => [Number(marker.startSeconds.toFixed(3)), marker.kind ?? "custom", marker.name]);

const songCase = {
  song: region.name,
  sheetKey,
  songKey: songKeyArg ?? region.key ?? null,
  regionEndSeconds: Number(region.endSeconds.toFixed(3)),
  bpm: session.bpm,
  tempoMarkers: (session.tempoMarkers ?? []).map((marker) => [Number(marker.startSeconds.toFixed(3)), marker.bpm]),
  timeSignature: session.timeSignature ?? "4/4",
  timeSignatureMarkers: (session.timeSignatureMarkers ?? []).map((marker) => [Number(marker.startSeconds.toFixed(3)), marker.signature]),
  markers,
  sheet: readFileSync(sheetPath, "utf8").replace(/\r\n?/g, "\n"),
  expect: null,
};
writeFileSync(outPath, `${JSON.stringify(songCase, null, 2)}\n`);
console.log(`${outPath}: ${markers.length} markers of "${region.name}"`);
