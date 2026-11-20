import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../shared/i18n";
import type { RegionReport } from "./lyricsApi";
import { DEFAULT_LYRICS_CONFIG } from "./lyricsEdits";
import { createLyricsHandlers, type LyricsApi } from "./lyricsHandlers";
import { LyricsSlidesBlock } from "./LyricsSlidesBlock";
import { captureSpaceBar, createStepRecorder } from "./lyricsStepRecorder";
import { INITIAL_LYRICS_STATE, useLyricsStore } from "./lyricsStore";

const REPORT: RegionReport = {
  regionId: "r1",
  regionName: "Way Maker",
  linkState: { state: "linked" },
  link: { software: "freeShow", presentationId: "s", presentationName: "Way Maker", overrides: [] },
  stored: true,
  groups: [],
  markers: [
    { markerId: "v1", markerName: "Verso 1", occurrence: 0, startSeconds: 0, status: "matched", groupLabel: "V", automatic: true, slideCount: 2, autoChangeBars: [5] },
    { markerId: "c", markerName: "Coro", occurrence: 0, startSeconds: 16, status: "matched", groupLabel: "C", automatic: true, slideCount: 2, autoChangeBars: [3] },
  ],
  suggestions: [],
  unmatchedSections: 0,
};

function makeApi(positions: number[]) {
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
    stepsFromTaps: vi.fn(async () => [{ markerId: "v1", offsetBeats: 16 }]),
    getTapPosition: vi.fn(async () => positions[index++] ?? 0),
    playTransport: vi.fn(async () => ({ playbackState: "playing" })),
    pauseTransport: vi.fn(async () => ({ playbackState: "paused" })),
    setLyricsRecording: vi.fn(async () => undefined),
    seekTransport: vi.fn(async () => ({ playbackState: "paused" })),
  } as unknown as LyricsApi & {
    setRegionLyrics: ReturnType<typeof vi.fn>;
    testSendLyrics: ReturnType<typeof vi.fn>;
    stepsFromTaps: ReturnType<typeof vi.fn>;
    playTransport: ReturnType<typeof vi.fn>;
    pauseTransport: ReturnType<typeof vi.fn>;
    seekTransport: ReturnType<typeof vi.fn>;
    setLyricsRecording: ReturnType<typeof vi.fn>;
  };
}

beforeEach(async () => {
  useLyricsStore.setState(INITIAL_LYRICS_STATE);
  useLyricsStore.getState().setConfigView({
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "freeShow", port: 5506 },
    hasToken: false,
  });
  await i18n.changeLanguage("es");
});

afterEach(() => cleanup());

describe("step recorder", () => {
  it("keeps taps inside sections, sends each one and summarises per section", async () => {
    const sendStep = vi.fn();
    const positions = [8, 20, 40];
    const recorder = createStepRecorder({
      sections: [
        { markerId: "v1", markerName: "Verso 1", startSeconds: 0, endSeconds: 16 },
        { markerId: "c", markerName: "Coro", startSeconds: 16, endSeconds: 24 },
      ],
      getPosition: async () => positions.shift()!,
      sendStep,
    });
    await recorder.tap();
    await recorder.tap();
    expect(await recorder.tap()).toBeNull();
    expect(sendStep.mock.calls).toEqual([
      ["v1", 1],
      ["c", 1],
    ]);
    expect(recorder.taps()).toEqual([8, 20]);
    expect(recorder.summary()).toEqual([
      { markerName: "Verso 1", changes: 1 },
      { markerName: "Coro", changes: 1 },
    ]);
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
});

function renderBlock(api: ReturnType<typeof makeApi>) {
  const handlers = createLyricsHandlers({ api, getRegionLyrics: () => null });
  const onSaved = vi.fn();
  render(
    <LyricsSlidesBlock
      regionId="r1"
      report={REPORT}
      regionStartSeconds={0}
      regionEndSeconds={24}
      stepMode="auto"
      handlers={handlers}
      onSaved={onSaved}
    />,
  );
  return onSaved;
}

describe("LyricsSlidesBlock", () => {
  it("plays, pauses and goes to the song start from the recorder (no keyboard on a phone)", async () => {
    const api = makeApi([]);
    renderBlock(api);
    fireEvent.click(screen.getByRole("button", { name: "Grabar cambios…" }));
    fireEvent.click(screen.getByRole("button", { name: /Reproducir/ }));
    await waitFor(() => expect(api.playTransport).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Pausa/ }));
    await waitFor(() => expect(api.pauseTransport).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Al inicio de la canción/ }));
    await waitFor(() => expect(api.seekTransport).toHaveBeenCalledWith(0));
  });

  it("still offers the recorder when the program shows no extra slides, with a note", () => {
    const handlers = createLyricsHandlers({ api: makeApi([]), getRegionLyrics: () => null });
    const single = {
      ...REPORT,
      markers: REPORT.markers.map((marker) => ({ ...marker, slideCount: 1, autoChangeBars: [] })),
    };
    render(
      <LyricsSlidesBlock
        regionId="r1"
        report={single}
        regionStartSeconds={0}
        regionEndSeconds={24}
        stepMode="auto"
        handlers={handlers}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Grabar cambios…" })).toBeTruthy();
    expect(screen.getByText(/no ve ninguna sección con varias diapositivas/)).toBeTruthy();
  });

  it("tells the worker the recorder is open and closed", async () => {
    const api = makeApi([]);
    renderBlock(api);
    fireEvent.click(screen.getByRole("button", { name: "Grabar cambios…" }));
    await waitFor(() => expect(api.setLyricsRecording).toHaveBeenCalledWith("r1"));
    fireEvent.click(screen.getByRole("button", { name: "Terminar" }));
    await waitFor(() => expect(api.setLyricsRecording).toHaveBeenLastCalledWith(null));
  });

  it("shows where the automatic changes fall", () => {
    renderBlock(makeApi([]));
    expect(screen.getByText(/Verso 1: cambia en el compás 5/)).toBeTruthy();
  });

  it("discard saves nothing; save stores the recording once", async () => {
    const api = makeApi([8, 20]);
    renderBlock(api);
    fireEvent.click(screen.getByRole("button", { name: "Grabar cambios…" }));
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    await waitFor(() => expect(api.testSendLyrics).toHaveBeenCalledWith("r1", "v1", 1));
    fireEvent.click(screen.getByRole("button", { name: "Terminar" }));
    expect(await screen.findByText("Verso 1: 1 cambios")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(api.setRegionLyrics).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Grabar cambios…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cambio" }));
    await waitFor(() => expect(api.testSendLyrics).toHaveBeenCalledWith("r1", "c", 1));
    fireEvent.click(screen.getByRole("button", { name: "Terminar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    expect(api.stepsFromTaps).toHaveBeenCalledWith("r1", [20]);
    const saved = api.setRegionLyrics.mock.calls[0][1];
    expect(saved.stepMode).toBe("manual");
    expect(saved.steps).toEqual([{ markerId: "v1", offsetBeats: 16 }]);
  });
});
