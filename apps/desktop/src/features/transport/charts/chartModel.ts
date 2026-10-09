import {
  markerCategory,
  type ChartAnchor,
  type SectionMarkerSummary,
  type SongChart,
  type SongRegionSummary,
} from "@libretracks/shared/models";

/** The stored id of an anchor: arrangements give repeats `"{id}~{n}"`, and a
 * repeat uses the anchor of its original marker. Mirrors Rust
 * `chart_anchor_marker_id`. */
export function chartAnchorMarkerId(markerId: string): string {
  const cut = markerId.indexOf("~");
  return cut < 0 ? markerId : markerId.slice(0, cut);
}

export function chartAnchorFor(
  chart: SongChart | null | undefined,
  markerId: string,
): ChartAnchor | null {
  if (!chart) return null;
  const base = chartAnchorMarkerId(markerId);
  return chart.anchors.find((anchor) => anchor.markerId === base) ?? null;
}

/** The section markers of a song, in timeline order. Cues (warnings, one-shot
 * announcements) never move the chart. */
export function chartSectionsForRegion(
  markers: readonly SectionMarkerSummary[],
  region: SongRegionSummary | null,
): SectionMarkerSummary[] {
  if (!region) return [];
  return markers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

/**
 * The anchor the chart should show at `positionSeconds`: that of the section
 * playing, or — if it has none — of the closest earlier section that does.
 * Before the first anchored section the chart shows the top of page 1.
 */
export function anchorAtPosition(
  chart: SongChart | null | undefined,
  sections: readonly SectionMarkerSummary[],
  positionSeconds: number,
): ChartAnchor | null {
  if (!chart) return null;
  let found: ChartAnchor | null = null;
  for (const section of sections) {
    if (section.startSeconds > positionSeconds + 0.001) break;
    found = chartAnchorFor(chart, section.id) ?? found;
  }
  return found;
}

/** The song whose chart is shown: the one playing, else the next one to play,
 * else the first. */
export function chartRegionAt(
  regions: readonly SongRegionSummary[],
  positionSeconds: number,
): SongRegionSummary | null {
  const sorted = [...regions].sort((left, right) => left.startSeconds - right.startSeconds);
  return (
    sorted.find(
      (region) =>
        positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
    ) ??
    sorted.find((region) => region.startSeconds > positionSeconds) ??
    sorted[0] ??
    null
  );
}

export type ChartPageLayout = {
  /** Top of each page in the scroller, in CSS px. */
  tops: number[];
  heights: number[];
};

/** Pages stacked at the scroller's width, with `gap` px between them.
 * `aspects` are height / width of each page. */
export function layoutChartPages(
  aspects: readonly number[],
  width: number,
  gap: number,
): ChartPageLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  let top = 0;
  for (const aspect of aspects) {
    const height = Math.max(1, Math.round(width * aspect));
    tops.push(top);
    heights.push(height);
    top += height + gap;
  }
  return { tops, heights };
}

/**
 * Scroll offset that puts an anchor near the top of the viewport. `leadRatio`
 * leaves a little of what comes before visible, so the musician sees the line
 * they are leaving as well as the one they arrive at.
 */
export function chartScrollTopFor(
  anchor: ChartAnchor | null,
  layout: ChartPageLayout,
  viewportHeight: number,
  leadRatio = 0.08,
): number {
  if (!anchor || layout.tops.length === 0) return 0;
  const page = Math.min(Math.max(0, anchor.page), layout.tops.length - 1);
  const y = layout.tops[page] + anchor.y * layout.heights[page];
  return Math.max(0, Math.round(y - viewportHeight * leadRatio));
}

/** Where a tap landed, as an anchor position: page index and height within
 * it. `offsetY` is measured from the top of the scroll content. */
export function chartPointAt(
  layout: ChartPageLayout,
  offsetY: number,
): { page: number; y: number } | null {
  for (let page = 0; page < layout.tops.length; page += 1) {
    const top = layout.tops[page];
    const height = layout.heights[page];
    if (offsetY >= top && offsetY <= top + height) {
      return { page, y: Math.min(1, Math.max(0, (offsetY - top) / height)) };
    }
  }
  return null;
}

/** Pages worth drawing: those that intersect the viewport plus one on each
 * side, so a smooth scroll never shows a blank page. Everything else keeps
 * its canvas released — a phone cannot hold a whole songbook in bitmaps. */
export function visibleChartPages(
  layout: ChartPageLayout,
  scrollTop: number,
  viewportHeight: number,
): number[] {
  const bottom = scrollTop + viewportHeight;
  const visible: number[] = [];
  layout.tops.forEach((top, page) => {
    if (top + layout.heights[page] > scrollTop && top < bottom) visible.push(page);
  });
  if (visible.length === 0) return [];
  const first = Math.max(0, visible[0] - 1);
  const last = Math.min(layout.tops.length - 1, visible[visible.length - 1] + 1);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
