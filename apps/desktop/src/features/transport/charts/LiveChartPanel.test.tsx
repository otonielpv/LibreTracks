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

function renderPanel(
  target: SongRegionSummary,
  position: { current: number },
  pendingMarkerId: string | null = null,
) {
  const onChartChange = vi.fn(async () => {});
  const utils = render(
    <LiveChartPanel
      song={songView(target)}
      region={target}
      positionSecondsRef={position}
      pendingMarkerId={pendingMarkerId}
      expanded={false}
      onToggleExpanded={vi.fn()}
      onClose={vi.fn()}
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
    // The block is named like the marker; the sheet's own name goes beside it.
    expect(container.querySelector(".lt-chart-section.is-current .lt-chart-section-label")?.textContent).toBe("EstrofaVerso 1");
    // No "up next" chip: the lyrics below already show it.
    expect(screen.queryByTitle("liveChart.upNext")).toBeNull();
  });

  it("scrolls so the current line sits near the top of the panel", () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
    const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) });
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute("data-testid") === "live-chart-scroller") return rect(100) as DOMRect;
      if (this.getAttribute("data-line-key") === "0-1") return rect(500) as DOMRect;
      return rect(0) as DOMRect;
    };
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
    try {
      // Second verse line playing; the line is 400 px below the scroller's top.
      renderPanel(region(linked), { current: 12 });
      // 400 px down, minus 18 % of a 300 px panel of lead.
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 346 }));
    } finally {
      Element.prototype.getBoundingClientRect = original;
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    }
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

  it("shows a scheduled jump right after the part playing", () => {
    // Playing the chorus with a jump back to the verse scheduled.
    const { container } = renderPanel(region(linked), { current: 25 }, "verse");
    const labels = [...container.querySelectorAll(".lt-chart-section")].map((node) => ({
      label: node.querySelector(".lt-chart-section-label")?.textContent,
      queued: node.classList.contains("is-queued"),
    }));
    // Playback started in the chorus: that is all that has played so far.
    expect(labels).toEqual([
      { label: "EstribilloCoro 1", queued: false },
      { label: "liveChart.jumpEstrofaVerso 1", queued: true },
      { label: "EstribilloCoro 1", queued: true },
    ]);
    // No "up next" chip: the lyrics below already show it.
    expect(screen.queryByTitle("liveChart.upNext")).toBeNull();
  });

  it("after a jump lands, the lyrics go on below it instead of scrolling back up", () => {
    vi.useFakeTimers();
    try {
      const position = { current: 25 };
      const onChartChange = vi.fn(async () => {});
      const view = (pending: string | null) => (
        <LiveChartPanel
          song={songView(region(linked))}
          region={region(linked)}
          positionSecondsRef={position}
          pendingMarkerId={pending}
          expanded={false}
          onToggleExpanded={vi.fn()}
          onClose={vi.fn()}
          onChartChange={onChartChange}
        />
      );
      // Chorus playing, a jump back to the verse scheduled: it shows below.
      const { container, rerender } = render(view("verse"));
      const sections = () =>
        [...container.querySelectorAll(".lt-chart-section")].map((node) => ({
          label: node.querySelector(".lt-chart-section-label")?.textContent?.replace("liveChart.jump", "→"),
          current: node.classList.contains("is-current"),
        }));
      expect(sections()).toEqual([
        { label: "EstribilloCoro 1", current: true },
        { label: "→EstrofaVerso 1", current: false },
        { label: "EstribilloCoro 1", current: false },
      ]);

      // The jump lands: the playhead is in the verse now, nothing pending.
      position.current = 1;
      rerender(view(null));
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(sections()).toEqual([
        { label: "EstribilloCoro 1", current: false },
        { label: "EstrofaVerso 1", current: true },
        { label: "EstribilloCoro 1", current: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the chords in the key the song is played in", () => {
    const { container } = renderPanel(region(linked, 2), { current: 0 });
    const chords = [...container.querySelectorAll(".lt-chart-chord")].map((node) => node.textContent);
    expect(chords.slice(0, 2)).toEqual(["D", "G"]);
  });

  it("draws a line of melody notes as notes, in the song's key", () => {
    const notes: SongChart = {
      text: ["{section: Intro}", "{start_of_tab}", "DC#-A-DC#//B", "{end_of_tab}"].join("\n"),
      links: [{ markerId: "verse", section: 0 }],
    };
    const { container } = renderPanel(region(notes, 2), { current: 0 });
    const groups = [...container.querySelectorAll(".lt-chart-notes > span")].map((node) => node.textContent);
    expect(groups).toEqual(["E D#", "B", "E D#", "‖", "C#"]);
    expect(container.querySelector("pre.lt-chart-tab")).toBeNull();
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

  it("while recording, the lines move only with the taps", () => {
    vi.useFakeTimers();
    try {
      const position = { current: 1 };
      const { container } = renderPanel(region(linked), position);
      fireEvent.click(screen.getByRole("button", { name: "liveChart.recordTimes" }));
      // 12 s into the verse: the even spread would be on the second line.
      position.current = 12;
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(lineTexts(container, ".lt-chart-line.is-current")).toEqual(["Primera línea"]);
      fireEvent.click(screen.getByRole("button", { name: /liveChart.nextLine/ }));
      expect(lineTexts(container, ".lt-chart-line.is-current")).toEqual(["Segunda línea"]);
    } finally {
      vi.useRealTimers();
    }
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
