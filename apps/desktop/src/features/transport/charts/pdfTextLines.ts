import type { SourceLine } from "./chartImport";

/**
 * Positioned PDF text → the lines the song-sheet analyser reads.
 *
 * Nothing here assumes a particular program made the PDF. It deals with what
 * varies between them:
 *   - several columns (two is common, to fit a song on one page): the columns
 *     are found as vertical bands no text crosses, and read one after another;
 *   - text drawn in many small pieces (each chord its own piece);
 *   - generators that write spaces as dots ("Quien.rompe.el.poder"), detected
 *     over the whole document so a lyric with a real full stop survives;
 *   - stanza breaks, from vertical gaps larger than the line spacing.
 */

export type PdfTextItem = {
  str: string;
  /** Baseline origin, PDF user space (y grows upwards). */
  x: number;
  y: number;
  width: number;
  /** Font size. */
  size: number;
};

export type PdfPageText = { width: number; height: number; items: PdfTextItem[] };

/** Words joined by dots and never a real space: the generator's spaces. */
export function usesDotSpaces(pages: readonly PdfPageText[]): boolean {
  let dotted = 0;
  let spaced = 0;
  for (const page of pages) {
    for (const item of page.items) {
      if (/\S \S/.test(item.str)) spaced += 1;
      else if (/[^\s.]\.[^\s.\d]/.test(item.str) || /^\.{2,}/.test(item.str)) dotted += 1;
    }
  }
  return dotted >= 3 && dotted > spaced * 4;
}

/** Vertical bands with (almost) no text: the gutters between columns. */
export function findColumnGutters(page: PdfPageText): number[] {
  const items = page.items.filter((item) => item.str.trim() && item.width < page.width * 0.45);
  if (items.length < 10) return [];
  const left = Math.max(0, Math.floor(Math.min(...items.map((item) => item.x))));
  const right = Math.min(Math.ceil(page.width), Math.ceil(Math.max(...items.map((item) => item.x + item.width))));
  const coverage = new Array<number>(Math.max(0, right - left + 1)).fill(0);
  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x) - left);
    const to = Math.min(coverage.length - 1, Math.ceil(item.x + item.width) - left);
    for (let x = from; x <= to; x += 1) coverage[x] += 1;
  }
  const typicalSize = median(items.map((item) => item.size)) || 10;
  const minGap = typicalSize * 1.2;
  const gutters: number[] = [];
  let start = -1;
  for (let x = 0; x <= coverage.length; x += 1) {
    const empty = x < coverage.length && coverage[x] === 0;
    if (empty && start < 0) start = x;
    if (!empty && start >= 0) {
      const mid = left + (start + x) / 2;
      const leftCount = items.filter((item) => item.x + item.width <= mid).length;
      const rightCount = items.filter((item) => item.x >= mid).length;
      // A real gutter has a column on each side, not a ragged right margin.
      if (x - start >= minGap && leftCount >= 5 && rightCount >= 5) gutters.push(mid);
      start = -1;
    }
  }
  return gutters;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

type Row = { y: number; size: number; items: PdfTextItem[] };

function rowsOf(items: readonly PdfTextItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(1, item.size * 0.3));
    if (row) {
      row.items.push(item);
      row.size = Math.max(row.size, item.size);
    } else {
      rows.push({ y: item.y, size: item.size, items: [item] });
    }
  }
  for (const row of rows) row.items.sort((left, right) => left.x - right.x);
  return rows.sort((left, right) => right.y - left.y);
}

export function pdfTextToSourceLines(pages: readonly PdfPageText[]): SourceLine[] {
  const dots = usesDotSpaces(pages);
  const clean = (text: string) => (dots ? text.replace(/\./g, " ") : text);

  const columns: Row[][] = [];
  for (const page of pages) {
    const items = page.items
      .map((item) => ({ ...item, str: clean(item.str) }))
      .filter((item) => item.str.trim());
    const gutters = findColumnGutters({ ...page, items });
    const buckets: PdfTextItem[][] = Array.from({ length: gutters.length + 1 }, () => []);
    for (const item of items) {
      // By where the item STARTS: a title that runs across the gutter belongs
      // to the column it begins in.
      const column = gutters.filter((gutter) => item.x >= gutter).length;
      buckets[column].push(item);
    }
    for (const bucket of buckets) if (bucket.length > 0) columns.push(rowsOf(bucket));
  }

  const spacing = median(
    columns.flatMap((rows) => rows.slice(1).map((row, index) => rows[index].y - row.y)).filter((gap) => gap > 0),
  );
  const lines: SourceLine[] = [];
  for (const rows of columns) {
    rows.forEach((row, index) => {
      const gap = index > 0 ? rows[index - 1].y - row.y : 0;
      lines.push({
        fragments: row.items.map((item) => ({ text: item.str, x: item.x, width: item.width })),
        size: row.size,
        // A new column or page starts a new block too.
        breakBefore: index === 0 || (spacing > 0 && gap > spacing * 1.5),
      });
    });
  }
  return lines;
}
