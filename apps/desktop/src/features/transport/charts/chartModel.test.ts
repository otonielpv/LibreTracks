import { describe, expect, it } from "vitest";

import type {
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
} from "@libretracks/shared/models";

import {
  anchorAtPosition,
  chartAnchorFor,
  chartAnchorMarkerId,
  chartPointAt,
  chartRegionAt,
  chartScrollTopFor,
  chartSectionsForRegion,
  layoutChartPages,
  visibleChartPages,
} from "./chartModel";

function marker(
  id: string,
  startSeconds: number,
  kind: SectionMarkerSummary["kind"] = "verse",
): SectionMarkerSummary {
  return { id, name: id, startSeconds, kind };
}

function region(id: string, startSeconds: number, endSeconds: number): SongRegionSummary {
  return {
    id,
    name: id,
    startSeconds,
    endSeconds,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
  } as SongRegionSummary;
}

const chart: SongChart = {
  filePath: "charts/song.pdf",
  anchors: [
    { markerId: "verse", page: 0, y: 0.1 },
    { markerId: "chorus", page: 1, y: 0.5 },
  ],
};

describe("chart anchors", () => {
  it("a repeat created by an arrangement uses its original marker's anchor", () => {
    expect(chartAnchorMarkerId("chorus~2")).toBe("chorus");
    expect(chartAnchorFor(chart, "chorus~2")).toEqual({ markerId: "chorus", page: 1, y: 0.5 });
    expect(chartAnchorFor(chart, "bridge")).toBeNull();
    expect(chartAnchorFor(null, "verse")).toBeNull();
  });

  it("follows the section playing, and keeps the last anchor through unanchored ones", () => {
    const sections = [marker("verse", 0), marker("bridge", 10), marker("chorus", 20)];
    expect(anchorAtPosition(chart, sections, 5)?.markerId).toBe("verse");
    // The bridge has no anchor: the chart stays where the verse left it.
    expect(anchorAtPosition(chart, sections, 15)?.markerId).toBe("verse");
    expect(anchorAtPosition(chart, sections, 20)?.markerId).toBe("chorus");
  });

  it("shows nothing anchored before the first anchored section", () => {
    const sections = [marker("intro", 0), marker("verse", 8)];
    expect(anchorAtPosition(chart, sections, 3)).toBeNull();
  });
});

describe("chart sections and songs", () => {
  it("only sections of the song move the chart, never cues or other songs", () => {
    const song = region("s1", 0, 30);
    const markers = [
      marker("chorus", 20, "chorus"),
      marker("verse", 0, "verse"),
      marker("build", 5, "build"),
      marker("next-song", 40, "intro"),
    ];
    expect(chartSectionsForRegion(markers, song).map((m) => m.id)).toEqual(["verse", "chorus"]);
    expect(chartSectionsForRegion(markers, null)).toEqual([]);
  });

  it("shows the song playing, else the next one, else the first", () => {
    const regions = [region("b", 40, 60), region("a", 0, 30)];
    expect(chartRegionAt(regions, 10)?.id).toBe("a");
    expect(chartRegionAt(regions, 35)?.id).toBe("b");
    expect(chartRegionAt(regions, 90)?.id).toBe("a");
    expect(chartRegionAt([], 0)).toBeNull();
  });
});

describe("chart page geometry", () => {
  // Two A4 portrait pages (aspect ~1.414) at 400px wide with a 10px gap.
  const layout = layoutChartPages([1.414, 1.414], 400, 10);

  it("stacks pages at the scroller width", () => {
    expect(layout.heights).toEqual([566, 566]);
    expect(layout.tops).toEqual([0, 576]);
  });

  it("puts an anchor near the top, leaving some lead above it", () => {
    // Chorus anchor: page 1 at half height = 576 + 283 = 859; 8% of 300 = 24.
    expect(chartScrollTopFor(chart.anchors[1], layout, 300)).toBe(835);
    expect(chartScrollTopFor(null, layout, 300)).toBe(0);
    // Never scrolls above the document.
    expect(chartScrollTopFor({ markerId: "x", page: 0, y: 0 }, layout, 300)).toBe(0);
    // A page beyond the document (chart replaced by a shorter one) clamps.
    expect(chartScrollTopFor({ markerId: "x", page: 9, y: 0 }, layout, 0)).toBe(576);
  });

  it("turns a tap into a page and a height within it", () => {
    expect(chartPointAt(layout, 283)).toEqual({ page: 0, y: 0.5 });
    expect(chartPointAt(layout, 576)).toEqual({ page: 1, y: 0 });
    // The gap between pages is not on any page.
    expect(chartPointAt(layout, 570)).toBeNull();
  });

  it("draws only the pages in view plus one on each side", () => {
    const five = layoutChartPages([1, 1, 1, 1, 1], 100, 0);
    expect(visibleChartPages(five, 250, 50)).toEqual([1, 2, 3]);
    expect(visibleChartPages(five, 0, 50)).toEqual([0, 1]);
    expect(visibleChartPages(layoutChartPages([], 100, 0), 0, 50)).toEqual([]);
  });
});
