import type { ChartFollow, FollowFocus } from "../models";

/**
 * The lyrics follow: which lines are "what is sung now" (the focus) and what
 * the panel keeps in view. One pure function for Live, Setlist, full screen
 * and the remote; the views only measure and scroll.
 *
 *   - 1 line (the default): the current line, kept at 18 % of the height.
 *   - 2 / 3 lines: fixed groups from the first line of the part (1-2, 3-4…),
 *     never across parts; the group's first line is kept at 18 %, so the
 *     panel only moves when the group changes.
 *   - Section: every line of the part; its header goes to the top when the
 *     part starts. A part taller than the panel turns pages: when the current
 *     line passes 80 % of the height it goes to the top (`PAGE_TURN_AT`,
 *     done by the view, which has the measures).
 *   - Off: the current line is highlighted, nothing scrolls.
 */

export const FOLLOW_FOCUSES: readonly FollowFocus[] = [1, 2, 3, "section", "off"];
export const DEFAULT_FOLLOW_FOCUS: FollowFocus = 1;
/** Where a "reading" anchor sits, as a fraction of the panel's height. */
export const READING_AT = 0.18;
/** Section focus: past this fraction of the height the page turns. */
export const PAGE_TURN_AT = 0.8;

/** A stored value → a focus, or `null` if it is not one. */
export function parseFollowFocus(value: unknown): FollowFocus | null {
  if (value === 1 || value === 2 || value === 3 || value === "section" || value === "off") return value;
  if (value === "1" || value === "2" || value === "3") return Number(value) as FollowFocus;
  return null;
}

/** The song's own follow wins; without one, the general (device) one. */
export function resolveFollow(song: ChartFollow | null | undefined, general: FollowFocus): FollowFocus {
  return parseFollowFocus(song?.focus) ?? general;
}

export type LyricsFocus = {
  /** Lines of the current block in the focus, or all of them. */
  lines: number[] | "all";
  /** What to keep in view (`data-line-key`), or nothing. */
  anchor: { key: string; align: "top" | "reading" } | null;
};

export function lyricsFocus({
  focus,
  currentBlock,
  currentLine,
  blockLineCount,
}: {
  focus: FollowFocus;
  currentBlock: number;
  currentLine: number | null;
  blockLineCount: number;
}): LyricsFocus {
  if (currentBlock < 0) return { lines: [], anchor: null };
  const head = `${currentBlock}-head`;
  if (currentLine === null) {
    // On the header, before the first line: nothing highlighted.
    if (focus === "off") return { lines: [], anchor: null };
    return { lines: [], anchor: { key: head, align: focus === "section" ? "top" : "reading" } };
  }
  if (focus === "off") return { lines: [currentLine], anchor: null };
  if (focus === "section") return { lines: "all", anchor: { key: head, align: "top" } };
  const size = focus;
  const start = Math.floor(currentLine / size) * size;
  const end = Math.min(start + size, Math.max(blockLineCount, currentLine + 1));
  const lines = Array.from({ length: Math.max(1, end - start) }, (_, index) => start + index);
  return { lines, anchor: { key: `${currentBlock}-${start}`, align: "reading" } };
}

/** How a line looks: in the focus, already sung, or still to come. */
export function focusLineState(
  focus: LyricsFocus,
  blockIndex: number,
  currentBlock: number,
  lineIndex: number,
): "current" | "past" | "upcoming" {
  if (blockIndex !== currentBlock) return blockIndex < currentBlock ? "past" : "upcoming";
  if (focus.lines === "all") return "current";
  if (focus.lines.length === 0) return "upcoming";
  if (focus.lines.includes(lineIndex)) return "current";
  return lineIndex < focus.lines[0] ? "past" : "upcoming";
}

/** The chart with this song's own follow, or without it (`null` = like all songs). */
export function withFollow<T extends { follow?: ChartFollow }>(chart: T, focus: FollowFocus | null): T {
  const { follow: _previous, ...rest } = chart;
  return (focus === null ? rest : { ...rest, follow: { focus } }) as T;
}
