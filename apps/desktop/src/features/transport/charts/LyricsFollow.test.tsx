import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));
vi.mock("../../chartSources/useChartSourcesAvailable", () => ({
  useChartSourcesAvailable: () => false,
  chartSourcesAvailableNow: () => false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LiveChartPanel } from "./LiveChartPanel";
import { useGeneralFollowStore } from "./LyricsFollowMenu";

// Verse: 0-20 s, four lines of 5 s each; chorus: 20-40 s, two lines.
const TEXT = ["{section: Verso}", "uno", "dos", "tres", "cuatro", "{section: Coro}", "gloria a ti", "santo eres"].join("\n");
const CHART: SongChart = {
  text: TEXT,
  links: [
    { markerId: "verse", section: 0 },
    { markerId: "chorus", section: 1 },
  ],
};

function region(chart: SongChart): SongRegionSummary {
  return {
    id: "song",
    name: "Gracia",
    startSeconds: 0,
    endSeconds: 40,
    transposeSemitones: 0,
    key: "C",
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  };
}

function view(target: SongRegionSummary): SongView {
  return {
    id: "session",
    title: "Session",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 40,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [target],
    sectionMarkers: [
      { id: "verse", name: "Verso", startSeconds: 0, kind: "verse" },
      { id: "chorus", name: "Coro", startSeconds: 20, kind: "chorus" },
    ],
    clips: [],
    tracks: [],
    projectRevision: 1,
  } as SongView;
}

function renderPanel(chart: SongChart, position: { current: number }) {
  const onChartChange = vi.fn(async (_id: string, _chart: SongChart | null) => {});
  const target = region(chart);
  render(
    <LiveChartPanel
      song={view(target)}
      region={target}
      positionSecondsRef={position}
      pendingMarkerId={null}
      expanded={false}
      onToggleExpanded={vi.fn()}
      onClose={vi.fn()}
      onChartChange={onChartChange}
    />,
  );
  return { onChartChange };
}

const current = () => [...document.querySelectorAll(".lt-chart-line.is-current .lt-chart-lyric")].map((node) => node.textContent);

describe("configurable lyrics follow", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    useGeneralFollowStore.setState({ focus: 1 });
    scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const play = (position: { current: number }, seconds: number) => {
    position.current = seconds;
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
  };

  it("C4: 2 lines highlights the group and scrolls only when the group changes", () => {
    useGeneralFollowStore.setState({ focus: 2 });
    const position = { current: 1 };
    renderPanel(CHART, position);
    expect(current()).toEqual(["uno", "dos"]);
    const calls = scrollTo.mock.calls.length;
    play(position, 6);
    expect(current()).toEqual(["uno", "dos"]);
    expect(scrollTo.mock.calls.length).toBe(calls);
    play(position, 11);
    expect(current()).toEqual(["tres", "cuatro"]);
    expect(scrollTo.mock.calls.length).toBe(calls + 1);
  });

  it("C4: a whole section highlights every line and scrolls only when the part changes", () => {
    const position = { current: 1 };
    renderPanel({ ...CHART, follow: { focus: "section" } }, position);
    expect(current()).toEqual(["uno", "dos", "tres", "cuatro"]);
    const calls = scrollTo.mock.calls.length;
    play(position, 6);
    play(position, 11);
    expect(scrollTo.mock.calls.length).toBe(calls);
    play(position, 25);
    expect(current()).toEqual(["gloria a ti", "santo eres"]);
    expect(scrollTo.mock.calls.length).toBe(calls + 1);
  });

  it("C4: without follow it never scrolls but still marks the line", () => {
    useGeneralFollowStore.setState({ focus: "off" });
    const position = { current: 1 };
    renderPanel(CHART, position);
    play(position, 6);
    play(position, 25);
    expect(current()).toEqual(["gloria a ti"]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("C5: Only in this song saves the chart's follow; Like all songs removes it; In all songs is the device's", async () => {
    const { onChartChange } = renderPanel(CHART, { current: 1 });
    fireEvent.click(screen.getByRole("button", { name: "lyricsFollow.title" }));
    const items = screen.getAllByRole("menuitemradio");
    // In all songs: 1, 2, 3, section, off; only in this song: like all, then the same five.
    expect(items).toHaveLength(11);
    await act(async () => {
      fireEvent.click(items[9]); // this song: section
    });
    expect(onChartChange).toHaveBeenLastCalledWith("song", { ...CHART, follow: { focus: "section" } });

    fireEvent.click(screen.getByRole("button", { name: "lyricsFollow.title" }));
    fireEvent.click(screen.getAllByRole("menuitemradio")[2]); // all songs: 3
    expect(useGeneralFollowStore.getState().focus).toBe(3);
    expect(window.localStorage.getItem("lt.liveChart.follow")).toBe("3");
  });

  it("C5: a song's own follow wins over the general one, and Like all songs removes it", async () => {
    useGeneralFollowStore.setState({ focus: 2 });
    const { onChartChange } = renderPanel({ ...CHART, follow: { focus: 1 } }, { current: 1 });
    expect(current()).toEqual(["uno"]);
    fireEvent.click(screen.getByRole("button", { name: "lyricsFollow.title" }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("menuitemradio")[5]); // this song: like all
    });
    expect(onChartChange).toHaveBeenLastCalledWith("song", CHART);
  });
});
