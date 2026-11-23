import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongChart, SongRegionSummary, SongView } from "@libretracks/shared/models";
import { recordProductEvent } from "../../telemetry/telemetry";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));
const sources = vi.hoisted(() => ({ available: false }));
vi.mock("../../chartSources/useChartSourcesAvailable", () => ({
  useChartSourcesAvailable: () => sources.available,
  chartSourcesAvailableNow: () => sources.available,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChartEditorHost } from "./ChartEditorHost";
import { useChartEditorStore } from "./chartEditorStore";
import { useChartImportStore } from "../../chartSources/chartImportStore";
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
  // The editor mounts in ChartEditorHost (LyricsRoot in the app), not in the panel.
  const utils = render(
    <>
      <ChartEditorHost />
      <LiveChartPanel
        song={songView(target)}
        region={target}
        positionSecondsRef={position}
        pendingMarkerId={pendingMarkerId}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
        onChartChange={onChartChange}
      />
    </>,
  );
  return { ...utils, onChartChange };
}

const lineTexts = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((node) =>
    [...node.querySelectorAll(".lt-chart-lyric")].map((lyric) => lyric.textContent).join(""),
  );

describe("LiveChartPanel", () => {
  beforeEach(() => {
    vi.mocked(recordProductEvent).mockClear();
    window.localStorage.clear();
    useChartEditorStore.setState({ session: null });
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
    expect(recordProductEvent).toHaveBeenCalledWith("feature_lyrics_chords");
  });

  it("does not count an empty lyrics panel as adoption", () => {
    renderPanel(region(null), { current: 0 });
    expect(recordProductEvent).not.toHaveBeenCalled();
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

  it("goes back to the line playing a few seconds after the reader scrolls away, with no line change", () => {
    vi.useFakeTimers();
    let now = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
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
      const { getByTestId } = renderPanel(region(linked), { current: 12 });
      scrollTo.mockClear();
      fireEvent.touchStart(getByTestId("live-chart-scroller"));
      fireEvent.touchMove(getByTestId("live-chart-scroller"));
      // Still reading: the lyrics stay where the reader left them.
      now += 3000;
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(scrollTo).not.toHaveBeenCalled();
      // Let go long enough: back to the second verse line.
      now += 1200;
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 346 }));
    } finally {
      Element.prototype.getBoundingClientRect = original;
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("full screen with songs: play, stop, the next song and the song list", () => {
    const target = region(linked);
    const other = { ...region(null), id: "other", name: "Otra", startSeconds: 40, endSeconds: 80 };
    const song = { ...songView(target), regions: [other, target] } as SongView;
    const onSelectSong = vi.fn();
    const onPlaySong = vi.fn();
    const props = {
      song,
      region: target,
      positionSecondsRef: { current: 12 },
      pendingMarkerId: null,
      onToggleExpanded: vi.fn(),
      onClose: vi.fn(),
      onChartChange: vi.fn(async () => {}),
      songs: { onSelectSong, onPlaySong },
    };
    const { rerender } = render(<LiveChartPanel {...props} expanded={false} />);
    // Not full screen: the lyrics alone, as before.
    expect(screen.queryByRole("toolbar", { name: "liveChart.dock.controls" })).toBeNull();

    rerender(<LiveChartPanel {...props} expanded />);
    expect(screen.getByRole("toolbar", { name: "liveChart.dock.controls" })).toBeTruthy();
    expect(screen.getByLabelText("liveChart.dock.play")).toBeTruthy();
    expect(screen.getByLabelText("liveChart.dock.stop")).toBeTruthy();
    // First song on the timeline: nothing before it.
    expect((screen.getByLabelText("liveChart.dock.previousSong") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("liveChart.dock.nextSong"));
    expect(onSelectSong).toHaveBeenLastCalledWith("other");

    fireEvent.click(screen.getByLabelText("liveChart.dock.songs"));
    const list = screen.getByRole("list", { name: "liveChart.dock.songs" });
    expect([...list.querySelectorAll(".lt-chart-dock-song-name")].map((node) => node.textContent)).toEqual(["Gracia", "Otra"]);
    // The song the playhead is in is marked.
    expect(list.querySelector("li.is-playing .lt-chart-dock-song-name")?.textContent).toBe("Gracia");
    fireEvent.click(screen.getAllByLabelText("liveChart.dock.playSong")[1]);
    expect(onPlaySong).toHaveBeenLastCalledWith(other);
    expect(onSelectSong).toHaveBeenLastCalledWith("other");
    // Picking a song closes the list.
    expect(screen.queryByRole("list", { name: "liveChart.dock.songs" })).toBeNull();
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
    // Playback started in the chorus; the verse before it still shows above,
    // so scrolling up reaches the start of the song.
    expect(labels).toEqual([
      { label: "EstrofaVerso 1", queued: false },
      { label: "EstribilloCoro 1", queued: false },
      { label: "liveChart.jumpEstrofaVerso 1", queued: true },
      { label: "EstribilloCoro 1", queued: true },
    ]);
    // No "up next" chip: the lyrics below already show it.
    expect(screen.queryByTitle("liveChart.upNext")).toBeNull();
  });

  it("after a jump back lands, above the target shows only the song before it", () => {
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
        { label: "EstrofaVerso 1", current: false },
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
      // Above the verse, only what comes before it on the timeline (nothing):
      // no log of the chorus that played.
      expect(sections()).toEqual([
        { label: "EstrofaVerso 1", current: true },
        { label: "EstribilloCoro 1", current: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the jump's target in place on screen when it lands and the blocks above it go", () => {
    vi.useFakeTimers();
    const scrollTops = new WeakMap<Element, number>();
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const original = Element.prototype.getBoundingClientRect;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) { return scrollTops.get(this) ?? 0; },
      set(this: Element, value: number) { scrollTops.set(this, value); },
    });
    // Every block 100 px tall, stacked in DOM order inside the scroller.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const scroller = this.closest("[data-testid='live-chart-scroller']");
      const sections = scroller ? [...scroller.querySelectorAll(".lt-chart-section")] : [];
      const index = sections.indexOf(this as HTMLElement);
      const top = this === scroller || index < 0 ? 0 : index * 100 - (scrollTops.get(scroller!) ?? 0);
      return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const position = { current: 1 };
      const view = (pending: string | null) => (
        <LiveChartPanel
          song={songView(region(linked))}
          region={region(linked)}
          positionSecondsRef={position}
          pendingMarkerId={pending}
          expanded={false}
          onToggleExpanded={vi.fn()}
          onClose={vi.fn()}
          onChartChange={vi.fn(async () => {})}
        />
      );
      const { getByTestId, rerender } = render(view(null));
      // Chorus playing, a jump back to the verse previewed below it.
      position.current = 25;
      act(() => {
        vi.advanceTimersByTime(150);
      });
      rerender(view("verse"));
      const scroller = getByTestId("live-chart-scroller");
      scroller.scrollTop = 250;
      rerender(view("verse"));
      // The preview sits third (200 px, 50 px below the top of the view). It
      // lands and becomes the first block (0 px): the scroll follows it, so it
      // is still 50 px below the top and nothing jumps under the reader.
      position.current = 1;
      rerender(view(null));
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(scroller.scrollTop).toBe(50);
    } finally {
      Element.prototype.getBoundingClientRect = original;
      if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
      vi.useRealTimers();
    }
  });

  it("with a vamp on the part playing, it comes next again, badged as looping", () => {
    render(
      <LiveChartPanel
        song={songView(region(linked))}
        region={region(linked)}
        positionSecondsRef={{ current: 5 }}
        pendingMarkerId={null}
        activeVamp={{ startSeconds: 0, endSeconds: 20 }}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
        onChartChange={vi.fn(async () => {})}
      />,
    );
    const sections = [...document.querySelectorAll(".lt-chart-section")].map((node) => ({
      label: node.querySelector(".lt-chart-section-label")?.textContent?.replace("repeat", ""),
      looped: node.classList.contains("is-looped"),
    }));
    expect(sections).toEqual([
      { label: "EstrofaVerso 1", looped: false },
      { label: "liveChart.vampEstrofaVerso 1", looped: true },
      { label: "EstribilloCoro 1", looped: false },
    ]);
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

  it("an imported file opens in the editor to adjust it to the sequence, not linked blind", async () => {
    const utils = renderPanel(region(null), { current: 0 });
    const sheet = "Verso 1\nC            F\nUna línea de letra\nCoro\nG\nOtra línea";
    const file = new File([sheet], "cancion.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => sheet });

    await act(async () => {
      fireEvent.change(screen.getByTestId("live-chart-file-input"), { target: { files: [file] } });
    });

    expect(utils.onChartChange).not.toHaveBeenCalled();
    const session = useChartEditorStore.getState().session;
    expect(session?.initialImport?.imported.text).toContain("[C]Una línea de [F]letra");
    expect(screen.getByRole("dialog", { name: "chartSources.adjust.title" })).toBeTruthy();
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

  // Setlist's Edit → Lyrics opens the panel with its editor; Live never asks.
  it("opens with the chart editor only when asked to (startEditing)", () => {
    const { unmount } = renderPanel(region(null), { current: 0 });
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    render(
      <>
        <ChartEditorHost />
        <LiveChartPanel
          song={songView(region(null))}
          region={region(null)}
          positionSecondsRef={{ current: 0 }}
          pendingMarkerId={null}
          expanded={false}
          onToggleExpanded={vi.fn()}
          onClose={vi.fn()}
          onChartChange={vi.fn(async () => {})}
          startEditing
        />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "liveChart.editorTitle" })).toBeTruthy();
  });

  it("offers import and typing when the song has no lyrics", () => {
    renderPanel(region(null), { current: 0 });
    expect(screen.getByRole("button", { name: "liveChart.importFile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "liveChart.pasteText" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers Planning Center when it is available, opening its picker for this song", () => {
    sources.available = true;
    try {
      renderPanel(region(null), { current: 0 });
      fireEvent.click(screen.getByRole("button", { name: "chartSources.import.open" }));
      expect(useChartImportStore.getState().session?.region.id).toBe(region(null).id);
    } finally {
      sources.available = false;
      useChartImportStore.getState().close();
    }
  });

  it("does not offer Planning Center when it is not available", () => {
    renderPanel(region(null), { current: 0 });
    expect(screen.queryByRole("button", { name: "chartSources.import.open" })).toBeNull();
  });

  // On a phone the editor turns the app to portrait and the view behind
  // changes layout and remounts the panel (Setlist: short -> medium). The
  // editor used to live in the panel and closed right after opening.
  it("keeps the editor open, with what was typed, when the panel remounts", () => {
    render(<ChartEditorHost />);
    const panel = (key: string) => (
      <LiveChartPanel
        key={key}
        song={songView(region(null))}
        region={region(null)}
        positionSecondsRef={{ current: 0 }}
        pendingMarkerId={null}
        expanded={false}
        onToggleExpanded={vi.fn()}
        onClose={vi.fn()}
        onChartChange={vi.fn(async () => {})}
      />
    );
    const view = render(panel("short"));
    fireEvent.click(screen.getByRole("button", { name: "liveChart.pasteText" }));
    const textarea = screen.getByRole("textbox", { name: "liveChart.textLabel" });
    fireEvent.change(textarea, { target: { value: "[G]Hola" } });
    view.rerender(panel("medium"));
    expect(screen.getByRole("dialog", { name: "liveChart.editorTitle" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "liveChart.textLabel" }) as HTMLTextAreaElement).value).toBe("[G]Hola");
  });

  it("spells each part in the key it sounds in when the song modulates", () => {
    // In C, +2 sounds in D (sharps); the chorus modulates to Eb, +2 = F (flats).
    const modulating: SongChart = {
      text: ["{section: Verso}", "[F#]Verso", "{section: Coro}", "[Ab]Coro"].join("\n"),
      links: linked.links,
    };
    const target = {
      ...region(modulating, 2),
      keyChanges: [{ id: "up", startSeconds: 20, key: "D#" }],
    };
    const { container } = renderPanel(target, { current: 0 });
    const chords = [...container.querySelectorAll(".lt-chart-chord")].map((node) => node.textContent);
    expect(chords).toEqual(["G#", "Bb"]);
  });
});
