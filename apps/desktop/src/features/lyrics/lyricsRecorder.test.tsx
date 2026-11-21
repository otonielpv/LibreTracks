import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegionLyrics } from "@libretracks/shared/models";

import i18n from "../../shared/i18n";
import type { MarkerReport, RegionReport } from "./lyricsApi";
import { DEFAULT_LYRICS_CONFIG, emptyRegionLyrics, spreadSlides } from "./lyricsEdits";
import { createLyricsHandlers, type LyricsApi } from "./lyricsHandlers";
import { LyricsSectionEditor } from "./LyricsSectionEditor";
import { captureSpaceBar, createStepRecorder } from "./lyricsStepRecorder";
import { INITIAL_LYRICS_STATE, useLyricsStore } from "./lyricsStore";
import { clearSlideThumbnails } from "./useSlideThumbnails";

function bridge(n: number, overrides: Partial<MarkerReport> = {}): MarkerReport {
  return {
    markerId: n === 0 ? "p" : `p~${n}`,
    markerName: "Puente",
    occurrence: n,
    startSeconds: 16 + n * 8,
    status: "matched",
    groupLabel: "Puente",
    automatic: true,
    slideCount: 4,
    slides: [5, 6, 7, 8],
    customSlides: false,
    endSeconds: 24 + n * 8,
    countInSeconds: 14 + n * 8,
    timing: { type: "auto" },
    lead: null,
    changePoints: [{ bar: 2, beat: 1 }, { bar: 3, beat: 1 }, { bar: 4, beat: 1 }],
    ...overrides,
  };
}

const REPORT: RegionReport = {
  regionId: "r1",
  regionName: "Digno",
  linkState: { state: "linked" },
  link: { software: "freeShow", presentationId: "s", presentationName: "Digno", overrides: [] },
  stored: true,
  groups: [],
  markers: [0, 1, 2, 3].map((n) => bridge(n)),
  suggestions: [],
  unmatchedSections: 0,
  slides: [
    { index: 1, groupLabel: "Verso", text: "Primera línea\nSegunda" },
    { index: 5, groupLabel: "Puente", text: "Digno" },
    { index: 6, groupLabel: "Puente", text: "Digno" },
    { index: 7, groupLabel: "Puente", text: "Digno" },
    { index: 8, groupLabel: "Puente", text: "Digno" },
  ],
  start: { automatic: true, slide: null },
};

function makeApi(positions: number[] = []) {
  let index = 0;
  return {
    getLyricsConfig: vi.fn(),
    saveLyricsConfig: vi.fn(),
    probeLyrics: vi.fn(),
    setLyricsPaused: vi.fn(),
    refreshLyrics: vi.fn(),
    markLyricsTutorialDone: vi.fn(),
    setRegionLyrics: vi.fn(async () => undefined),
    testSendLyrics: vi.fn(async () => undefined),
    getRegionReport: vi.fn(),
    getSetlistReport: vi.fn(),
    listPresentations: vi.fn(),
    sectionStepsFromTaps: vi.fn(async () => [{ markerId: "p~1", offsetBeats: 4 }]),
    getSlideThumbnails: vi.fn(async (_id: string, indexes: number[], cachedOnly?: boolean) =>
      indexes.map((index) => (!cachedOnly && index === 5 ? "data:image/png;base64,AAAA" : null)),
    ),
    getTapPosition: vi.fn(async () => positions[Math.min(index++, positions.length - 1)] ?? 0),
    playTransport: vi.fn(async () => ({ playbackState: "playing" })),
    pauseTransport: vi.fn(async () => ({ playbackState: "paused" })),
    setLyricsRecording: vi.fn(async () => undefined),
    seekTransport: vi.fn(async () => ({ playbackState: "paused" })),
  } as unknown as LyricsApi & {
    setRegionLyrics: ReturnType<typeof vi.fn>;
    testSendLyrics: ReturnType<typeof vi.fn>;
    sectionStepsFromTaps: ReturnType<typeof vi.fn>;
    playTransport: ReturnType<typeof vi.fn>;
    pauseTransport: ReturnType<typeof vi.fn>;
    seekTransport: ReturnType<typeof vi.fn>;
    getTapPosition: ReturnType<typeof vi.fn>;
    getSlideThumbnails: ReturnType<typeof vi.fn>;
  };
}

const LINKED: RegionLyrics = {
  ...emptyRegionLyrics(),
  links: [{ software: "freeShow", presentationId: "s", presentationName: "Digno", overrides: [] }],
};

function renderEditor(api: ReturnType<typeof makeApi>, marker: MarkerReport) {
  const handlers = createLyricsHandlers({ api, getRegionLyrics: () => LINKED });
  const onSave = vi.fn((work: Promise<unknown>) => void work);
  render(
    <LyricsSectionEditor
      regionId="r1"
      report={REPORT}
      marker={marker}
      handlers={handlers}
      onSave={onSave}
      onBack={vi.fn()}
    />,
  );
  return onSave;
}

function lastSaved(api: ReturnType<typeof makeApi>): RegionLyrics {
  const calls = api.setRegionLyrics.mock.calls;
  return calls[calls.length - 1][1] as RegionLyrics;
}

beforeEach(async () => {
  clearSlideThumbnails();
  useLyricsStore.setState(INITIAL_LYRICS_STATE);
  useLyricsStore.getState().setConfigView({
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "freeShow", port: 5506 },
    hasToken: false,
  });
  await i18n.changeLanguage("es");
});

afterEach(() => cleanup());

describe("section recorder", () => {
  it("keeps only taps inside its section and sends each one as the next slide", async () => {
    const sendStep = vi.fn();
    const positions = [14, 18, 21, 30];
    const recorder = createStepRecorder({
      section: { markerId: "p", startSeconds: 16, endSeconds: 24 },
      getPosition: async () => positions.shift()!,
      sendStep,
    });
    expect(await recorder.tap()).toBe(false);
    expect(await recorder.tap()).toBe(true);
    expect(await recorder.tap()).toBe(true);
    expect(await recorder.tap()).toBe(false);
    expect(sendStep.mock.calls).toEqual([
      ["p", 1],
      ["p", 2],
    ]);
    expect(recorder.taps()).toEqual([18, 21]);
  });

  it("while recording the space bar taps and never reaches play/pause; afterwards it does", () => {
    const playPause = vi.fn();
    const onSpace = (event: KeyboardEvent) => {
      if (event.code === "Space") playPause();
    };
    window.addEventListener("keydown", onSpace);
    const tap = vi.fn();
    const release = captureSpaceBar(window, tap);
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    expect(tap).toHaveBeenCalledTimes(1);
    expect(playPause).not.toHaveBeenCalled();
    release();
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    expect(tap).toHaveBeenCalledTimes(1);
    expect(playPause).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onSpace);
  });

  it("spreads slides evenly among repeats", () => {
    expect(spreadSlides([5, 6, 7, 8], 4)).toEqual([[5], [6], [7], [8]]);
    expect(spreadSlides([5, 6, 7, 8], 2)).toEqual([
      [5, 6],
      [7, 8],
    ]);
    expect(spreadSlides([5, 6], 3)).toEqual([[5], [5], [6]]);
  });
});

describe("LyricsSectionEditor", () => {
  it("shows the program's picture of a slide when it gives one, its full text otherwise", async () => {
    const api = makeApi();
    renderEditor(api, bridge(0));
    await waitFor(() => expect(document.querySelectorAll(".lt-lyrics-slide-screen img").length).toBe(1));
    // First what is on disk, all at once; then one slide per request.
    expect(api.getSlideThumbnails.mock.calls[0]).toEqual(["s", [1, 5, 6, 7, 8], true]);
    expect(api.getSlideThumbnails).toHaveBeenCalledWith("s", [5], false);
    const verse = screen.getByRole("button", { name: "Verso · Primera línea" });
    expect(verse.querySelector(".lt-lyrics-slide-text")?.textContent).toBe("Primera línea\nSegunda");
  });

  it("asks for the missing pictures in parallel, not one after another", async () => {
    const api = makeApi();
    let inFlight = 0;
    let most = 0;
    api.getSlideThumbnails.mockImplementation(async (_id: string, indexes: number[], cachedOnly?: boolean) => {
      if (cachedOnly) return indexes.map(() => null);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return ["data:image/png;base64,AAAA"];
    });
    renderEditor(api, bridge(0));
    await waitFor(() => expect(document.querySelectorAll(".lt-lyrics-slide-screen img").length).toBe(5));
    expect(most).toBe(5);
  });

  it("saves the slides chosen by hand against that exact repeat", async () => {
    const api = makeApi();
    renderEditor(api, bridge(1));
    // Start from the group's 4: drop two and add the verse slide.
    fireEvent.click(screen.getAllByRole("button", { name: "Puente · Digno" })[2]);
    fireEvent.click(screen.getAllByRole("button", { name: "Puente · Digno" })[3]);
    fireEvent.click(screen.getByRole("button", { name: "Verso · Primera línea" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar selección" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    expect(lastSaved(api).links[0].slides).toEqual([{ markerId: "p~1", indexes: [1, 5, 6] }]);
  });

  it("one part per repeat gives each of the 4 bridges its own slide in one save", async () => {
    const api = makeApi();
    renderEditor(api, bridge(0));
    fireEvent.click(screen.getByRole("button", { name: "Una parte por repetición (4)" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    expect(lastSaved(api).links[0].slides).toEqual([
      { markerId: "p", indexes: [5] },
      { markerId: "p~1", indexes: [6] },
      { markerId: "p~2", indexes: [7] },
      { markerId: "p~3", indexes: [8] },
    ]);
  });

  it("every N bars is stored for that repeat only", async () => {
    const api = makeApi();
    renderEditor(api, bridge(2));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Compases entre diapositivas" }), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Cada/ }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    expect(lastSaved(api).sections).toEqual([{ markerId: "p~2", timing: { type: "everyBars", bars: 4 } }]);
  });

  it("recording plays from a bar before the marker, stops at its end and saves once", async () => {
    // Tap at 26 s; the poll then reads 33 s (past the end at 32 s).
    const api = makeApi([26, 33]);
    renderEditor(api, bridge(1));
    fireEvent.click(screen.getByRole("button", { name: /Grabar/ }));
    await waitFor(() => expect(api.playTransport).toHaveBeenCalled());
    expect(api.seekTransport).toHaveBeenCalledWith(22);
    fireEvent.click(screen.getByRole("button", { name: "Cambio" }));
    await waitFor(() => expect(api.testSendLyrics).toHaveBeenCalledWith("r1", "p~1", 1));
    // Stops by itself at the end of the section.
    await waitFor(() => expect(screen.getByText("1 cambios grabados")).toBeTruthy());
    expect(api.pauseTransport).toHaveBeenCalled();
    expect(api.setRegionLyrics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar grabación" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    expect(api.sectionStepsFromTaps).toHaveBeenCalledWith("r1", "p~1", [26]);
    const saved = lastSaved(api);
    expect(saved.steps).toEqual([{ markerId: "p~1", offsetBeats: 4 }]);
    expect(saved.sections).toEqual([{ markerId: "p~1", timing: { type: "recorded" } }]);
  });

  it("discarding a recording saves nothing", async () => {
    const api = makeApi([40]);
    renderEditor(api, bridge(1));
    fireEvent.click(screen.getByRole("button", { name: /Grabar/ }));
    await waitFor(() => expect(screen.getByText("No se grabó ningún cambio.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(api.setRegionLyrics).not.toHaveBeenCalled();
    expect(api.sectionStepsFromTaps).not.toHaveBeenCalled();
  });
});
