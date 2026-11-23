import type { SectionMarkerSummary, SongChart } from "../models";

import { buildImportReview, type ImportReview } from "./chartImportReview";
import { parseChordPro, type ChartDoc, type ChartSection } from "./chordChart";
import { chartTextHash, normalizeImportedChart, type ImportedChart } from "./importedChart";

/**
 * "Update from Planning Center" (D12): what changed in the source since the
 * import, and the same review as an import, with the markers that already
 * had a section keeping it. Pure; the dialog draws it.
 */
export type SectionChange = { label: string; change: "added" | "removed" | "changed" };

export type RefreshResult =
  | { upToDate: true }
  | {
      upToDate: false;
      review: ImportReview;
      changes: SectionChange[];
      /** The text no longer matches what was imported: edited here. */
      editedLocally: boolean;
    };

/** The words of a section (chords and spacing apart): a transposed import
 * and its source still read as the same section. */
function words(section: ChartSection): string {
  return section.lines
    .map((line) => (line.kind === "lyrics" ? line.segments.map((segment) => segment.text).join("") : line.text))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Sections followed by label and which repeat of the label they are (the
 * second "Coro" is the second "Coro"), as `remapChartLinks` does. */
function keyed(doc: ChartDoc): Map<string, number> {
  const counts = new Map<string, number>();
  const keys = new Map<string, number>();
  doc.sections.forEach((section, index) => {
    const label = section.label.trim().toLowerCase();
    const repeat = counts.get(label) ?? 0;
    counts.set(label, repeat + 1);
    keys.set(`${label}#${repeat}`, index);
  });
  return keys;
}

export function compareCharts(before: ChartDoc, after: ChartDoc): SectionChange[] {
  const old = keyed(before);
  const fresh = keyed(after);
  const changes: SectionChange[] = [];
  for (const [key, index] of fresh) {
    const previous = old.get(key);
    const label = after.sections[index].label;
    if (previous === undefined) changes.push({ label, change: "added" });
    else if (words(before.sections[previous]) !== words(after.sections[index])) changes.push({ label, change: "changed" });
  }
  for (const [key, index] of old) {
    if (!fresh.has(key)) changes.push({ label: before.sections[index].label, change: "removed" });
  }
  return changes;
}

export function buildRefreshReview(
  current: SongChart,
  imported: ImportedChart,
  markers: readonly SectionMarkerSummary[],
  songKey: string | null,
): RefreshResult {
  const savedDate = current.source?.updatedAt;
  const sourceDate = imported.source?.updatedAt;
  if (savedDate && sourceDate && savedDate === sourceDate) return { upToDate: true };

  const before = parseChordPro(current.text);
  const after = parseChordPro(normalizeImportedChart(imported).text);
  // The markers that had a section keep it while that section still exists.
  const afterKeys = keyed(after);
  const beforeKeys = [...keyed(before).entries()];
  const locked = current.links.flatMap((link) => {
    const key = beforeKeys.find(([, index]) => index === link.section)?.[0];
    const section = key === undefined ? undefined : afterKeys.get(key);
    return section === undefined ? [] : [{ markerId: link.markerId, section }];
  });
  // Recorded line times travel when the section kept the same lines: they
  // are per line, so a section with lines added or changed starts even again.
  const keepLineBeats: Record<string, { section: number; lineBeats: number[] }> = {};
  for (const link of current.links) {
    const section = locked.find((entry) => entry.markerId === link.markerId)?.section;
    if (section === undefined || !link.lineBeats?.length) continue;
    const old = before.sections[link.section];
    const fresh = after.sections[section];
    if (old && fresh && old.lines.length === fresh.lines.length && words(old) === words(fresh)) {
      keepLineBeats[link.markerId] = { section, lineBeats: [...link.lineBeats] };
    }
  }
  return {
    upToDate: false,
    review: { ...buildImportReview(imported, markers, songKey, locked), keepLineBeats },
    changes: compareCharts(before, after),
    editedLocally: Boolean(current.source) && current.source!.importedHash !== chartTextHash(current.text),
  };
}
