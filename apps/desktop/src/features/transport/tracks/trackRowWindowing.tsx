import type { ReactNode } from "react";

import type { TrackRowLayout } from "./trackLayout";
import type { VisibleTrackRows } from "./useVisibleTrackRows";

/**
 * Rows the DOM mounts for a window, in order, with spacers standing in for
 * the rows in between. Headers and lanes render from the same list, so a row
 * sits at the same height in both columns.
 *
 * The spacers come straight from `layout.tops`/`heights`, so the content keeps
 * exactly `layout.totalHeight` (rule 5 of docs/plans/completed/track-virtualization): a
 * pinned row outside the window splits a spacer in two and stays in place.
 */

export type TrackRowSegment =
  | { kind: "row"; index: number }
  | { kind: "spacer"; key: string; height: number };

export function trackRowSegments(
  layout: TrackRowLayout,
  rowWindow: Pick<VisibleTrackRows, "startIndex" | "endIndex" | "pinnedIndices">,
): TrackRowSegment[] {
  const rowCount = layout.heights.length;
  const indices = new Set<number>();
  for (let index = Math.max(0, rowWindow.startIndex); index < Math.min(rowCount, rowWindow.endIndex); index += 1) {
    indices.add(index);
  }
  for (const index of rowWindow.pinnedIndices) {
    if (index >= 0 && index < rowCount) {
      indices.add(index);
    }
  }
  const mounted = [...indices].sort((left, right) => left - right);

  // Track rows are whole pixels; a uniform layout of fractional items (the
  // compact mixer's strips) is not, and `i * size` leaves crumbs of 1e-13 px
  // between neighbours. Those are not gaps.
  const minGap = 1e-6;
  const segments: TrackRowSegment[] = [];
  let cursor = 0;
  for (const index of mounted) {
    const gap = layout.tops[index] - cursor;
    if (gap > minGap) {
      segments.push({ kind: "spacer", key: `spacer-before-${index}`, height: gap });
    }
    segments.push({ kind: "row", index });
    cursor = layout.tops[index] + layout.heights[index];
  }
  if (layout.totalHeight - cursor > minGap) {
    segments.push({ kind: "spacer", key: "spacer-end", height: layout.totalHeight - cursor });
  }
  return segments;
}

/**
 * Maps the tracks like `tracks.map(renderRow)`, mounting only the window.
 * Without a window, or with every row mounted, it IS `tracks.map(renderRow)`:
 * same nodes, no spacers.
 */
export function renderTrackRows<Track>(
  tracks: readonly Track[],
  layout: TrackRowLayout,
  rowWindow: VisibleTrackRows | undefined,
  renderRow: (track: Track) => ReactNode,
): ReactNode[] {
  if (!rowWindow?.isWindowed || layout.heights.length !== tracks.length) {
    return tracks.map(renderRow);
  }
  return trackRowSegments(layout, rowWindow).map((segment) =>
    segment.kind === "row" ? (
      renderRow(tracks[segment.index])
    ) : (
      <div
        key={segment.key}
        className="lt-track-row-spacer"
        aria-hidden="true"
        style={{ height: segment.height }}
      />
    ),
  );
}
