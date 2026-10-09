import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { LiveChartPanel } from "./LiveChartPanel";

const TEXT = [
  "{title: Gracia}",
  "{section: Verso 1}",
  "[C]Primera línea",
  "[F]Segunda línea",
  "{section: Coro 1}",
  "[G]Coro uno",
  "[Am]Coro dos",
].join("\n");

function region(chart: SongChart | null, transposeSemitones = 0): SongRegionSummary {
  return {
    id: "song",
    name: "Gracia",
    startSeconds: 0,
    endSeconds: 40,
    transposeSemitones,
    key: "C",
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    chart,
  };
}

function songView(target: SongRegionSummary): SongView {
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
      { id: "verse", name: "Estrofa", startSeconds: 0, kind: "verse" },
      { id: "chorus", name: "Estribillo", startSeconds: 20, kind: "chorus" },
    ],
    clips: [],
    tracks: [],
    projectRevision: 1,
  } as SongView;
}

const linked: SongChart = {
  text: TEXT,
  links: [
    { markerId: "verse", section: 0 },
    { markerId: "chorus", section: 1 },
  ],
};

function renderPanel(target: SongRegionSummary, position: { current: number }) {
  const onChartChange = vi.fn(async () => {});
  const utils = render(
    <LiveChartPanel
      song={songView(target)}
      region={target}
      positionSecondsRef={position}
      expanded={false}
      onToggleExpanded={vi.fn()}
      onChartChange={onChartChange}
    />,
  );
  return { ...utils, onChartChange };
}

const lineTexts = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((node) =>
    [...node.querySelectorAll(".lt-chart-lyric")].map((lyric) => lyric.textContent).join(""),
  );

describe("LiveChartPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLElement.prototype.scrollTo = vi.fn() as never;
  });

  it("highlights the line playing and dims the ones already sung", () => {
    // Verse: 20 s and two lines → the second starts at 10 s.
    const { container } = renderPanel(region(linked), { current: 12 });
    expect(lineTexts(container, ".lt-chart-line.is-current")).toEqual(["Segunda línea"]);
    expect(lineTexts(container, ".lt-chart-line.is-past")).toEqual(["Primera línea"]);
    expect(container.querySelector(".lt-chart-section.is-current .lt-chart-section-label")?.textContent).toBe("Verso 1");
    // What comes next is announced.
    expect(screen.getByTitle("liveChart.upNext").textContent).toContain("Coro 1");
  });

  it("follows the playhead into the next section", () => {
    vi.useFakeTimers();
    try {
      const position = { current: 1 };
      const { container } = renderPanel(region(linked), position);
      position.current = 31;
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(lineTexts(container, ".lt-chart-line.is-current")).toEqual(["Coro dos"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the chords in the key the song is played in", () => {
    const { container } = renderPanel(region(linked, 2), { current: 0 });
    const chords = [...container.querySelectorAll(".lt-chart-chord")].map((node) => node.textContent);
    expect(chords.slice(0, 2)).toEqual(["D", "G"]);
  });

  it("hides the chords for singers who only want the words", () => {
    const { container } = renderPanel(region(linked), { current: 0 });
    fireEvent.click(screen.getByRole("button", { name: "liveChart.showChords" }));
    expect(container.querySelectorAll(".lt-chart-chord")).toHaveLength(0);
    expect(window.localStorage.getItem("lt.liveChart.showChords")).toBe("false");
  });

  it("imports a text sheet and links it to the song's markers by meaning", async () => {
    const { onChartChange } = renderPanel(region(null), { current: 0 });
    const sheet = "Verso 1\nC            F\nUna línea de letra\nCoro\nG\nOtra línea";
    const file = new File([sheet], "cancion.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => sheet });

    await act(async () => {
      fireEvent.change(screen.getByTestId("live-chart-file-input"), { target: { files: [file] } });
    });

    expect(onChartChange).toHaveBeenCalledTimes(1);
    const [regionId, chart] = onChartChange.mock.calls[0] as unknown as [string, SongChart];
    expect(regionId).toBe("song");
    expect(chart.text).toContain("{section: Verso 1}");
    expect(chart.text).toContain("[C]Una línea de [F]letra");
    expect(chart.links).toEqual([
      { markerId: "verse", section: 0 },
      { markerId: "chorus", section: 1 },
    ]);
  });

  it("records when each line starts and saves it in beats", async () => {
    const position = { current: 0 };
    const { onChartChange } = renderPanel(region(linked), position);
    fireEvent.click(screen.getByRole("button", { name: "liveChart.recordTimes" }));

    // 120 BPM: the second verse line comes in at 3 s = beat 6.
    position.current = 3;
    fireEvent.click(screen.getByRole("button", { name: /liveChart.nextLine/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "liveChart.stopRecording" }));
    });

    expect(onChartChange).toHaveBeenCalledWith("song", {
      text: TEXT,
      links: [
        { markerId: "verse", section: 0, lineBeats: [0, 6] },
        { markerId: "chorus", section: 1 },
      ],
    });
  });

  it("offers import and typing when the song has no lyrics", () => {
    renderPanel(region(null), { current: 0 });
    expect(screen.getByRole("button", { name: "liveChart.importFile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "liveChart.pasteText" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
