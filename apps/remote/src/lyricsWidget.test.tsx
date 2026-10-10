import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";

import { LyricsWidget, lyricsRegionAt } from "./lyricsWidget";

const TEXT = [
  "{section: Verso 1}",
  "[C]Primera línea",
  "[F]Segunda línea",
  "{section: Coro 1}",
  "[G]Coro uno",
].join("\n");

function region(id: string, start: number, end: number, chart: SongChart | null, transpose = 0): SongRegionSummary {
  return {
    id,
    name: id,
    startSeconds: start,
    endSeconds: end,
    transposeSemitones: transpose,
    key: "C",
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  };
}

const chart: SongChart = {
  text: TEXT,
  links: [
    { markerId: "verse", section: 0 },
    { markerId: "chorus", section: 1 },
  ],
};

function songView(regions: SongRegionSummary[]): SongView {
  return {
    id: "session",
    title: "Session",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 80,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions,
    sectionMarkers: [
      { id: "verse", name: "Estrofa", startSeconds: 0, kind: "verse" },
      { id: "chorus", name: "Estribillo", startSeconds: 20, kind: "chorus" },
    ],
    clips: [],
    tracks: [],
    projectRevision: 1,
  } as SongView;
}

const currentLines = (container: HTMLElement) =>
  [...container.querySelectorAll(".lyrics-line.is-current .lyrics-text")].map((node) => node.textContent);

describe("LyricsWidget", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLElement.prototype.scrollTo = vi.fn() as never;
  });

  it("follows the song playing, line by line, in its key", () => {
    // Verse: 20 s and two lines → the second starts at 10 s.
    const { container } = render(
      <LyricsWidget
        songView={songView([region("song", 0, 40, chart, 2)])}
        getPositionSeconds={() => 12}
        pendingMarkerId={null}
      />,
    );
    expect(currentLines(container)).toEqual(["Segunda línea"]);
    const chords = [...container.querySelectorAll(".lyrics-chord")].map((node) => node.textContent);
    expect(chords.slice(0, 2)).toEqual(["D", "G"]);
    expect(container.querySelector(".lyrics-block.is-current .lyrics-block-label")?.textContent).toBe("Estrofa");
  });

  it("shows a scheduled jump right after the part playing", () => {
    const { container } = render(
      <LyricsWidget
        songView={songView([region("song", 0, 40, chart)])}
        getPositionSeconds={() => 25}
        pendingMarkerId="verse"
      />,
    );
    const queued = [...container.querySelectorAll(".lyrics-block.is-queued .lyrics-block-label")].map((node) => node.textContent);
    expect(queued[0]).toContain("Estrofa");
  });

  it("says so when the song has no lyrics", () => {
    render(
      <LyricsWidget
        songView={songView([region("song", 0, 40, null)])}
        getPositionSeconds={() => 0}
        pendingMarkerId={null}
      />,
    );
    expect(screen.queryByTestId("lyrics-scroller")).toBeNull();
    expect(document.querySelector(".lyrics-empty")).not.toBeNull();
  });

  it("follows the song playing, else the next one", () => {
    const regions = [region("b", 50, 80, null), region("a", 0, 40, null)];
    expect(lyricsRegionAt(regions, 10)?.id).toBe("a");
    expect(lyricsRegionAt(regions, 45)?.id).toBe("b");
  });
});
