import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";
import { parseTimeSignature } from "../timelineMath";

import { buildImportReview, finalizeImport, type ReviewTiming } from "./chartImportReview";
import { buildPerformanceBlocks, chartLinkFor, chartLinkPasses } from "./chartSync";
import { parseChordPro } from "./chordChart";
import { planningCenterToImported } from "./importedChart";
import { planningCenterExport } from "./planningCenterExport";

/**
 * Real songs with their real Planning Center sheets, kept OUTSIDE git
 * (docs/plans/smart-chart-import/cases/, see scripts/chart-case-from-session.mjs):
 * the lyrics are copyrighted. Without the folder (CI, other machines) this is
 * skipped. Each case prints what the import makes of it and, when it has an
 * "expect" list, checks it.
 */

type SongCase = {
  song: string;
  sheetKey: string | null;
  songKey: string | null;
  regionEndSeconds: number;
  bpm: number;
  tempoMarkers: Array<[number, number]>;
  timeSignature: string;
  timeSignatureMarkers: Array<[number, string]>;
  markers: Array<[number, string, string]>;
  sheet: string;
  /** [marker name, section label or null, passes], one per marker. */
  expect: Array<[string, string | null, number]> | null;
  /** Optional: what Planning Center should get when saving with slashes. */
  expectMarks?: string[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.resolve(here, "../../../../docs/plans/smart-chart-import/cases");
const files = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".json")) : [];

function timingOf(songCase: SongCase): ReviewTiming {
  const tempo = [...songCase.tempoMarkers].sort((left, right) => left[0] - right[0]);
  const meters = [...songCase.timeSignatureMarkers].sort((left, right) => left[0] - right[0]);
  const at = <T>(list: Array<[number, T]>, seconds: number, base: T) =>
    list.reduce((value, [start, next]) => (start <= seconds + 0.001 ? next : value), base);
  return {
    regionEndSeconds: songCase.regionEndSeconds,
    secondsPerBeatAt: (seconds) => 60 / Math.max(1, at(tempo, seconds, songCase.bpm)),
    beatsPerBarAt: (seconds) => parseTimeSignature(at(meters, seconds, songCase.timeSignature)).beatsPerBar,
  };
}

describe.skipIf(files.length === 0)("private chart cases (real sheets, outside git)", () => {
  for (const file of files) {
    const songCase = JSON.parse(readFileSync(path.join(folder, file), "utf8")) as SongCase;
    it(`${file}: ${songCase.song}`, () => {
      const markers: SectionMarkerSummary[] = songCase.markers.map(([startSeconds, kind, name], index) => ({
        id: `m${index}`,
        name,
        startSeconds,
        kind: kind as SectionMarkerSummary["kind"],
      }));
      const review = buildImportReview(
        planningCenterToImported({ id: "a", songId: "s", chordChart: songCase.sheet, chordChartKey: songCase.sheetKey }),
        markers,
        songCase.songKey,
        [],
        timingOf(songCase),
      );
      const rows = review.rows.map(
        (row) => [row.name, row.section === null ? null : review.doc.sections[row.section].label, row.passes] as const,
      );
      const chart = finalizeImport(review, { transpose: true, linked: true });
      const doc = parseChordPro(chart.text);
      const { blocks } = buildPerformanceBlocks(doc, chart.links, markers, [], null, false, (id) =>
        chartLinkPasses(chartLinkFor(chart.links, id)),
      );
      const marks = planningCenterExport(chart.text, chart.links, markers, "marks");
      console.info(
        [
          `\n=== ${songCase.song}`,
          `changes: ${review.changes.map((change) => change.kind + ("label" in change ? `:${change.label}` : "")).join(", ") || "none"}`,
          ...rows.map(([name, label, passes]) => `  ${name.padEnd(14)} -> ${(label ?? "-").padEnd(14)} x${passes}`),
          `Live blocks: ${blocks.map((block) => block.label).join(" | ")}`,
          `Planning Center (slashes):\n${marks.chordChart}`,
        ].join("\n"),
      );
      if (songCase.expect) expect(rows.map((row) => [...row])).toEqual(songCase.expect);
      for (const line of songCase.expectMarks ?? []) expect(marks.chordChart).toContain(line);
    });
  }
});
