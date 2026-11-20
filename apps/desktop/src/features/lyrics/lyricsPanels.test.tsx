import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LyricsConfig, RegionLyrics, SongView } from "@libretracks/shared/models";

import i18n from "../../shared/i18n";
import { useSongStore } from "../transport/songStore";
import type { LyricsConfigView, RegionReport } from "./lyricsApi";
import { DEFAULT_LYRICS_CONFIG } from "./lyricsEdits";
import type { LyricsApi } from "./lyricsHandlers";
import { LyricsSetlistLinker } from "./LyricsSetlistLinker";
import { LyricsSongPanel } from "./LyricsSongPanel";
import { lyricsSongMenuItems } from "./lyricsSongMenu";
import { INITIAL_LYRICS_STATE, useLyricsStore } from "./lyricsStore";

const LINKED: RegionLyrics = {
  enabled: true,
  links: [{ software: "holyrics", presentationId: "812", presentationName: "Way Maker", overrides: [] }],
  steps: [],
  stepMode: "auto",
  lead: null,
};

function setSong(lyrics: Record<string, RegionLyrics | null>) {
  const regions = Object.entries(lyrics).map(([id, regionLyrics], index) => ({
    id,
    name: id === "r1" ? "Way Maker" : `Song ${index}`,
    startSeconds: index * 100,
    endSeconds: index * 100 + 90,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    lyrics: regionLyrics,
  }));
  useSongStore.getState().setSong({ regions, sectionMarkers: [] } as unknown as SongView);
}

function report(partial: Partial<RegionReport>): RegionReport {
  return {
    regionId: "r1",
    regionName: "Way Maker",
    linkState: { state: "linked" },
    link: { software: "holyrics", presentationId: "812", presentationName: "Way Maker", overrides: [] },
    stored: true,
    groups: [
      { label: "Verso 1", slideCount: 2 },
      { label: "Coro", slideCount: 2 },
      { label: "Coro 2", slideCount: 1 },
    ],
    markers: [
      { markerId: "v1", markerName: "Verso 1", occurrence: 0, startSeconds: 4, status: "matched", groupLabel: "Verso 1", automatic: true, slideCount: 2, autoChangeBars: [5] },
      { markerId: "c", markerName: "Coro", occurrence: 0, startSeconds: 20, status: "matched", groupLabel: "Coro", automatic: true, slideCount: 2, autoChangeBars: [5] },
      { markerId: "c~1", markerName: "Coro", occurrence: 1, startSeconds: 36, status: "matched", groupLabel: "Coro", automatic: true, slideCount: 2, autoChangeBars: [5] },
    ],
    suggestions: [],
    unmatchedSections: 0,
    ...partial,
  };
}

function makeApi(overrides: Partial<LyricsApi> = {}) {
  const view: LyricsConfigView = {
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "holyrics", port: 8091 } as LyricsConfig,
    hasToken: true,
  };
  const base = {
    getLyricsConfig: vi.fn(async () => view),
    saveLyricsConfig: vi.fn(async () => view),
    probeLyrics: vi.fn(async () => ({ version: "x", presentations: 0 })),
    setLyricsPaused: vi.fn(async () => undefined),
    refreshLyrics: vi.fn(async () => undefined),
    markLyricsTutorialDone: vi.fn(async () => view),
    setRegionLyrics: vi.fn(async (_regionId: string, _lyrics: RegionLyrics | null): Promise<unknown> => undefined),
    testSendLyrics: vi.fn(async () => undefined),
    getRegionReport: vi.fn(async () => report({})),
    getSetlistReport: vi.fn(async () => [] as RegionReport[]),
    stepsFromTaps: vi.fn(async () => []),
    getTapPosition: vi.fn(async () => 0),
    playTransport: vi.fn(async () => ({ playbackState: "playing" }) as never),
    pauseTransport: vi.fn(async () => ({ playbackState: "paused" }) as never),
    setLyricsRecording: vi.fn(async () => undefined),
    seekTransport: vi.fn(async () => ({ playbackState: "paused" }) as never),
    listPresentations: vi.fn(async () => [{ id: "812", name: "Way Maker" }]),
  } satisfies LyricsApi;
  return { ...base, ...overrides } as typeof base;
}

beforeEach(async () => {
  useLyricsStore.setState(INITIAL_LYRICS_STATE);
  useLyricsStore.getState().setConfigView({
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "holyrics", port: 8091 },
    hasToken: true,
  });
  await i18n.changeLanguage("es");
});

afterEach(() => {
  cleanup();
  useSongStore.getState().setSong(null);
});

describe("LyricsSetlistLinker", () => {
  it("exact titles show linked, ambiguous ones offer suggestions and accept-all saves once per song", async () => {
    setSong({ r1: LINKED, r2: null, r3: null, r4: null });
    const api = makeApi({
      getSetlistReport: vi.fn(async () => [
        report({}),
        report({
          regionId: "r2",
          regionName: "Oceans",
          linkState: { state: "suggested" },
          link: null,
          stored: false,
          markers: [],
          suggestions: [
            { id: "a", name: "Oceans", score: 0.95 },
            { id: "b", name: "Oceans (Live)", score: 0.9 },
          ],
        }),
        report({ regionId: "r3", regionName: "Tu Fidelidad", stored: false, link: { software: "holyrics", presentationId: "77", presentationName: "Tu Fidelidad", overrides: [] } }),
        report({ regionId: "r4", regionName: "Nada", linkState: { state: "notFound" }, link: null, stored: false, markers: [] }),
      ]),
    });
    render(<LyricsSetlistLinker api={api} />);
    expect(await screen.findByText("Way Maker", { selector: ".lt-lyrics-state-linked" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usar «Oceans»" })).toBeTruthy();
    expect(screen.getByText("Sin encontrar.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aceptar todas las sugerencias (2)" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(2));
    const saved = api.setRegionLyrics.mock.calls.map(([regionId, lyrics]) => [
      regionId,
      (lyrics as RegionLyrics).links[0].presentationId,
    ]);
    expect(saved).toEqual([
      ["r2", "a"],
      ["r3", "77"],
    ]);
  });
});

describe("LyricsSongPanel", () => {
  it("changing a repeat only this time stores a ~n correction; every time stores the base one", async () => {
    setSong({ r1: LINKED });
    const api = makeApi();
    render(<LyricsSongPanel regionId="r1" api={api} />);
    const select = await screen.findByLabelText("Grupo para Coro (vez 2)");
    fireEvent.change(select, { target: { value: "Coro 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Solo esta vez" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(1));
    const once = api.setRegionLyrics.mock.calls[0][1] as RegionLyrics;
    expect(once.links[0].overrides).toEqual([{ markerId: "c~1", target: { type: "group", label: "Coro 2" } }]);

    fireEvent.change(await screen.findByLabelText("Grupo para Coro (vez 2)"), {
      target: { value: "Coro 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Todas las veces" }));
    await waitFor(() => expect(api.setRegionLyrics).toHaveBeenCalledTimes(2));
    // The second edit builds on the first (it used to overwrite it: only
    // the last correction survived and the linker kept counting the rest).
    const every = api.setRegionLyrics.mock.calls[1][1] as RegionLyrics;
    expect(every.links[0].overrides).toEqual([
      { markerId: "c~1", target: { type: "group", label: "Coro 2" } },
      { markerId: "c", target: { type: "group", label: "Coro 2" } },
    ]);
  });

  it("test sends that section with k = 0", async () => {
    setSong({ r1: LINKED });
    const api = makeApi();
    render(<LyricsSongPanel regionId="r1" api={api} />);
    const buttons = await screen.findAllByRole("button", { name: "Probar" });
    fireEvent.click(buttons[1]);
    expect(api.testSendLyrics).toHaveBeenCalledWith("r1", "c", 0);
  });

  it("offline it shows the saved link read-only and saves nothing on open", async () => {
    setSong({ r1: LINKED });
    const api = makeApi({
      getRegionReport: vi.fn(async () => {
        throw { kind: "unreachable", detail: "refused" };
      }),
    });
    render(<LyricsSongPanel regionId="r1" api={api} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Vinculada a «Way Maker»");
    expect(screen.getAllByText("Way Maker").length).toBeGreaterThan(0);
    expect(api.setRegionLyrics).not.toHaveBeenCalled();
  });
});

describe("song menu entry", () => {
  it("only appears with the sync on and opens the one song panel", () => {
    const t = (key: string) => key;
    const region = { id: "r1", name: "Way Maker" } as never;
    const [entry] = lyricsSongMenuItems(region, t);
    entry.onSelect();
    expect(useLyricsStore.getState().songPanelRegionId).toBe("r1");
    useLyricsStore.getState().setConfigView({ config: DEFAULT_LYRICS_CONFIG, hasToken: false });
    expect(lyricsSongMenuItems(region, t)).toEqual([]);
  });
});
