import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegionLyrics, SectionMarkerSummary, SongRegionSummary, SongView } from "@libretracks/shared/models";

/**
 * Los cuatro menús de escribir texto piden vertical al abrirse en un teléfono
 * y horizontal al cerrarse (plan portrait-text-modals, paso 3).
 */

const setScreenOrientation = vi.fn<(mode: string) => Promise<void>>(async () => undefined);
const platform = { isMobileApp: true };

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  get isMobileApp() {
    return platform.isMobileApp;
  },
  setScreenOrientation: (mode: string) => setScreenOrientation(mode),
}));

const i18n = (await import("../../../shared/i18n")).default;
const { useSongStore } = await import("../songStore");
const { ChartEditorModal } = await import("../charts/ChartEditorModal");
const { LyricsSongPanel } = await import("../../lyrics/LyricsSongPanel");
const { LyricsSetlistLinker } = await import("../../lyrics/LyricsSetlistLinker");
const { LyricsSectionEditor } = await import("../../lyrics/LyricsSectionEditor");
const { DEFAULT_LYRICS_CONFIG } = await import("../../lyrics/lyricsEdits");
const { createLyricsHandlers } = await import("../../lyrics/lyricsHandlers");
const { INITIAL_LYRICS_STATE, useLyricsStore } = await import("../../lyrics/lyricsStore");
const { resetPortraitWhileOpenForTests } = await import("./usePortraitWhileOpen");
type LyricsApi = import("../../lyrics/lyricsHandlers").LyricsApi;
type RegionReport = import("../../lyrics/lyricsApi").RegionReport;

const LINKED: RegionLyrics = {
  enabled: true,
  links: [{ software: "holyrics", presentationId: "812", presentationName: "Way Maker", overrides: [] }],
  steps: [],
  stepMode: "auto",
  lead: null,
};

const REPORT: RegionReport = {
  regionId: "r1",
  regionName: "Way Maker",
  linkState: { state: "linked" },
  link: LINKED.links[0],
  stored: true,
  groups: [{ label: "Coro", slideCount: 2 }],
  markers: [
    { markerId: "c", markerName: "Coro", occurrence: 0, startSeconds: 20, status: "matched", groupLabel: "Coro", automatic: true, slideCount: 2, slides: [1, 2], customSlides: false, endSeconds: 30, countInSeconds: 2, timing: { type: "auto" }, lead: null, changePoints: [{ bar: 5, beat: 1 }] },
  ],
  suggestions: [],
  unmatchedSections: 0,
  slides: [{ index: 1, groupLabel: "Coro", text: "Line" }],
} as RegionReport;

function makeApi(): LyricsApi {
  const view = {
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "holyrics" as const, port: 8091 },
    hasToken: true,
  };
  return {
    getLyricsConfig: vi.fn(async () => view),
    saveLyricsConfig: vi.fn(async () => view),
    probeLyrics: vi.fn(async () => ({ version: "x", presentations: 0 })),
    setLyricsPaused: vi.fn(async () => undefined),
    refreshLyrics: vi.fn(async () => undefined),
    markLyricsTutorialDone: vi.fn(async () => view),
    setRegionLyrics: vi.fn(async () => undefined),
    testSendLyrics: vi.fn(async () => undefined),
    getRegionReport: vi.fn(async () => REPORT),
    getSetlistReport: vi.fn(async () => [REPORT]),
    sectionStepsFromTaps: vi.fn(async () => []),
    getSlideThumbnails: vi.fn(async (_id: string, indexes: number[]) => indexes.map(() => null)),
    getTapPosition: vi.fn(async () => 0),
    playTransport: vi.fn(async () => ({ playbackState: "playing" }) as never),
    pauseTransport: vi.fn(async () => ({ playbackState: "paused" }) as never),
    setLyricsRecording: vi.fn(async () => undefined),
    seekTransport: vi.fn(async () => ({ playbackState: "paused" }) as never),
    listPresentations: vi.fn(async () => [{ id: "812", name: "Way Maker" }]),
    scanLyrics: vi.fn(async () => []),
  } as unknown as LyricsApi;
}

const calls = () => setScreenOrientation.mock.calls.map(([mode]) => mode);

beforeEach(async () => {
  vi.clearAllMocks();
  resetPortraitWhileOpenForTests();
  platform.isMobileApp = true;
  // Un teléfono, ya en horizontal: el cierre no tiene que esperar al giro.
  window.matchMedia = ((query: string) =>
    ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  useLyricsStore.setState(INITIAL_LYRICS_STATE);
  useLyricsStore.getState().setConfigView({
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "holyrics", port: 8091 },
    hasToken: true,
  });
  useSongStore.getState().setSong({
    regions: [{ id: "r1", name: "Way Maker", startSeconds: 0, endSeconds: 90, lyrics: LINKED }],
    sectionMarkers: [],
  } as unknown as SongView);
  await i18n.changeLanguage("es");
});

afterEach(() => {
  cleanup();
  useSongStore.getState().setSong(null);
});

describe("menús de texto en vertical en el teléfono", () => {
  it("Editor de letra y acordes", async () => {
    const onClose = vi.fn();
    render(
      <ChartEditorModal
        region={{ id: "r1", name: "Way Maker", startSeconds: 0, endSeconds: 90 } as SongRegionSummary}
        markers={[] as SectionMarkerSummary[]}
        chart={null}
        secondsPerBeatAt={() => 0.5}
        onSave={vi.fn(async () => {})}
        onClose={onClose}
      />,
    );
    expect(calls()).toEqual(["portrait"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(calls()).toEqual(["portrait", "landscape"]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Letra en proyección", async () => {
    const closeSongPanel = vi.fn();
    useLyricsStore.setState({ closeSongPanel });
    render(<LyricsSongPanel regionId="r1" api={makeApi()} />);
    expect(calls()).toEqual(["portrait"]);
    fireEvent.click(await screen.findByRole("button", { name: "Listo" }));
    expect(calls()).toEqual(["portrait", "landscape"]);
    await waitFor(() => expect(closeSongPanel).toHaveBeenCalledTimes(1));
  });

  it("Letra en proyección: entrar y salir del editor de diapositivas no gira", async () => {
    render(<LyricsSongPanel regionId="r1" api={makeApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar diapositivas de Coro" }));
    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    await screen.findByRole("button", { name: "Editar diapositivas de Coro" });
    await Promise.resolve();
    expect(calls()).toEqual(["portrait"]);
  });

  it("Editor de diapositivas por sección", async () => {
    const handlers = createLyricsHandlers({ api: makeApi(), getRegionLyrics: () => LINKED });
    const view = render(
      <LyricsSectionEditor
        regionId="r1"
        report={REPORT}
        marker={REPORT.markers[0]}
        handlers={handlers}
        onSave={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(calls()).toEqual(["portrait"]);
    view.unmount();
    await waitFor(() => expect(calls()).toEqual(["portrait", "landscape"]));
  });

  it("Vincular canciones", async () => {
    const closeLinker = vi.fn();
    useLyricsStore.setState({ closeLinker });
    render(<LyricsSetlistLinker api={makeApi()} />);
    expect(calls()).toEqual(["portrait"]);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(calls()).toEqual(["portrait", "landscape"]);
    await waitFor(() => expect(closeLinker).toHaveBeenCalledTimes(1));
  });

  it("en escritorio ninguno pide nada", async () => {
    platform.isMobileApp = false;
    const closeLinker = vi.fn();
    useLyricsStore.setState({ closeLinker });
    const view = render(<LyricsSetlistLinker api={makeApi()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(closeLinker).toHaveBeenCalledTimes(1);
    view.unmount();
    await Promise.resolve();
    expect(setScreenOrientation).not.toHaveBeenCalled();
  });
});
