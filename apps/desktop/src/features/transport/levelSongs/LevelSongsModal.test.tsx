// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MeasureSongLoudnessRequest,
  MeasureSongLoudnessResult,
  SongLoudness,
} from "@libretracks/shared/desktopApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

/**
 * What must hold from the user's side: the click never goes into the
 * measurement, and Apply writes exactly the masters the table shows for the
 * ticked songs — in one call, so one undo restores them.
 */
const measureSongLoudness =
  vi.fn<(request: MeasureSongLoudnessRequest) => Promise<MeasureSongLoudnessResult>>();
const updateSongRegionMasterGains =
  vi.fn<(gains: { regionId: string; masterGain: number }[]) => Promise<TransportSnapshot>>();
const cancelMeasureSongLoudness = vi.fn(async () => {});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

// Teléfono simulado para el giro a vertical (plan portrait-text-modals).
const phone = { on: false };
const setScreenOrientation = vi.fn(async (_mode: string) => {});

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  get isMobileApp() {
    return phone.on;
  },
  setScreenOrientation: (mode: string) => setScreenOrientation(mode),
  getSettings: async () => ({ metronomeOutput: "master", voiceGuideOutput: "monitor" }),
  measureSongLoudness: (request: MeasureSongLoudnessRequest) => measureSongLoudness(request),
  cancelMeasureSongLoudness: () => cancelMeasureSongLoudness(),
  listenToLevelSongsProgress: async () => () => {},
  updateSongRegionMasterGains: (gains: { regionId: string; masterGain: number }[]) =>
    updateSongRegionMasterGains(gains),
}));

const { LevelSongsModal } = await import("./LevelSongsModal");
const { useLevelSongsStore } = await import("./levelSongsStore");
const { useSongStore } = await import("../songStore");

const audioTrack = (id: string, name: string) =>
  ({
    id,
    name,
    kind: "audio",
    depth: 0,
    parentTrackId: null,
    muted: false,
    solo: false,
    audioTo: "master",
  }) as never;

function song(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [
      { id: "b", name: "Second", startSeconds: 100, endSeconds: 200, master: { gain: 1 } } as never,
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100, master: { gain: 1 } } as never,
      { id: "c", name: "Third", startSeconds: 200, endSeconds: 300, master: { gain: 1 } } as never,
    ],
    tracks: [audioTrack("drums", "Drums"), audioTrack("keys", "Keys"), audioTrack("click", "Click")],
    clips: [
      { id: "c1", trackId: "drums", timelineStartSeconds: 0, durationSeconds: 300 } as never,
      { id: "c2", trackId: "keys", timelineStartSeconds: 0, durationSeconds: 300 } as never,
      { id: "c3", trackId: "click", timelineStartSeconds: 0, durationSeconds: 300 } as never,
    ],
    projectRevision: 1,
  };
}

const loudness = (regionId: string, loudLufs: number): SongLoudness => ({
  regionId,
  hasSignal: true,
  integratedLufs: loudLufs - 2,
  loudLufs,
  loudnessRangeLu: 4,
  samplePeak: 0.1,
  tracksWithAudio: ["drums", "keys"],
});

beforeEach(() => {
  vi.clearAllMocks();
  useSongStore.setState({ song: song() });
  useLevelSongsStore.setState({ open: true });
});

afterEach(() => {
  cleanup();
  useLevelSongsStore.setState({ open: false });
});

describe("LevelSongsModal", () => {
  it("renders nothing while closed", () => {
    useLevelSongsStore.setState({ open: false });
    const { container } = render(<LevelSongsModal onApplied={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("measures every song in timeline order without the click", async () => {
    measureSongLoudness.mockResolvedValue({
      cancelled: false,
      songs: [loudness("a", -10), loudness("b", -14), loudness("c", -16)],
      missingFiles: [],
    });
    render(<LevelSongsModal onApplied={() => {}} />);

    const click = await screen.findByRole("checkbox", { name: /Click/ });
    expect((click as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText("transport.levelSongs.measure"));

    await waitFor(() => expect(measureSongLoudness).toHaveBeenCalledTimes(1));
    expect(measureSongLoudness.mock.calls[0][0]).toEqual({
      regionIds: ["a", "b", "c"],
      trackIds: ["drums", "keys"],
    });
  });

  it("applies the proposed masters of the ticked songs in one call", async () => {
    // Real multitracks: summed at unity they already peak at 0 dBFS, so no
    // song can come up and the default target is the quietest one (-16).
    const peaking = (regionId: string, lufs: number) => ({
      ...loudness(regionId, lufs),
      samplePeak: 1,
    });
    measureSongLoudness.mockResolvedValue({
      cancelled: false,
      songs: [peaking("a", -10), peaking("b", -14), peaking("c", -16)],
      missingFiles: [],
    });
    const snapshot = { marker: "after" } as unknown as TransportSnapshot;
    updateSongRegionMasterGains.mockResolvedValue(snapshot);
    const onApplied = vi.fn();
    render(<LevelSongsModal onApplied={onApplied} />);

    await screen.findByRole("checkbox", { name: /Click/ });
    fireEvent.click(screen.getByText("transport.levelSongs.measure"));
    // "Third" is the quietest: it is the target and stays unticked.
    const third = await screen.findByRole("checkbox", { name: "Third" });
    expect((third as HTMLInputElement).checked).toBe(false);
    // Leave "Second" out.
    fireEvent.click(screen.getByRole("checkbox", { name: "Second" }));
    fireEvent.click(screen.getByText(/transport.levelSongs.apply/));

    await waitFor(() => expect(updateSongRegionMasterGains).toHaveBeenCalledTimes(1));
    const gains = updateSongRegionMasterGains.mock.calls[0][0];
    expect(gains).toHaveLength(1);
    expect(gains[0].regionId).toBe("a");
    expect(gains[0].masterGain).toBeCloseTo(10 ** (-6 / 20));
    expect(onApplied).toHaveBeenCalledWith(snapshot);
    await screen.findByText(/transport.levelSongs.applied/);
  });

  it("the median is still one choice away", async () => {
    measureSongLoudness.mockResolvedValue({
      cancelled: false,
      songs: [loudness("a", -10), loudness("b", -14), loudness("c", -16)].map((m) => ({
        ...m,
        samplePeak: 1,
      })),
      missingFiles: [],
    });
    updateSongRegionMasterGains.mockResolvedValue({} as TransportSnapshot);
    render(<LevelSongsModal onApplied={() => {}} />);
    await screen.findByRole("checkbox", { name: /Click/ });
    fireEvent.click(screen.getByText("transport.levelSongs.measure"));
    const select = await screen.findByDisplayValue("transport.levelSongs.targetNoClip");
    fireEvent.change(select, { target: { value: "median" } });
    fireEvent.click(screen.getByText(/transport.levelSongs.apply/));
    await waitFor(() => expect(updateSongRegionMasterGains).toHaveBeenCalledTimes(1));
    // Median -14: "First" comes down 4 dB; the others cannot come up.
    expect(updateSongRegionMasterGains.mock.calls[0][0]).toEqual([
      { regionId: "a", masterGain: expect.closeTo(10 ** (-4 / 20), 5) },
    ]);
  });

  it("folds each song's tracks under its name and a song's box ticks them all", async () => {
    // Each song with its own stems: a setlist, not one long track list.
    useSongStore.setState({
      song: {
        ...song(),
        tracks: [audioTrack("d1", "Drums"), audioTrack("k1", "Keys"), audioTrack("d2", "Drums")],
        clips: [
          { id: "1", trackId: "d1", timelineStartSeconds: 0, durationSeconds: 90 } as never,
          { id: "2", trackId: "k1", timelineStartSeconds: 0, durationSeconds: 90 } as never,
          { id: "3", trackId: "d2", timelineStartSeconds: 110, durationSeconds: 80 } as never,
        ],
      },
    });
    measureSongLoudness.mockResolvedValue({ cancelled: false, songs: [], missingFiles: [] });
    render(<LevelSongsModal onApplied={() => {}} />);

    // Folded: the song rows are there, their tracks are not.
    const first = await screen.findByRole("checkbox", { name: "First" });
    expect(screen.queryByRole("checkbox", { name: /Drums/ })).toBeNull();
    fireEvent.click(first);
    fireEvent.click(screen.getByText("transport.levelSongs.measure"));

    await waitFor(() => expect(measureSongLoudness).toHaveBeenCalledTimes(1));
    expect(measureSongLoudness.mock.calls[0][0].trackIds).toEqual(["d2"]);
  });

  it("a cancelled measurement goes back to the setup and says so", async () => {
    measureSongLoudness.mockResolvedValue({ cancelled: true, songs: [], missingFiles: [] });
    render(<LevelSongsModal onApplied={() => {}} />);
    await screen.findByRole("checkbox", { name: /Click/ });
    fireEvent.click(screen.getByText("transport.levelSongs.measure"));
    await screen.findByText("transport.levelSongs.cancelled");
    expect(updateSongRegionMasterGains).not.toHaveBeenCalled();
  });
});

describe("Nivelar canciones en un teléfono", () => {
  it("se abre en vertical y Cancelar vuelve a horizontal antes de cerrar", async () => {
    const { resetPortraitWhileOpenForTests } = await import("../mobile/usePortraitWhileOpen");
    const originalMatchMedia = window.matchMedia;
    resetPortraitWhileOpenForTests();
    phone.on = true;
    // Un teléfono, ya en horizontal: el cierre no espera al giro.
    window.matchMedia = ((query: string) =>
      ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      render(<LevelSongsModal onApplied={() => {}} />);
      await waitFor(() => expect(setScreenOrientation.mock.calls.map(([mode]) => mode)).toEqual(["portrait"]));
      fireEvent.click(await screen.findByText("transport.levelSongs.cancel"));
      await waitFor(() =>
        expect(setScreenOrientation.mock.calls.map(([mode]) => mode)).toEqual(["portrait", "landscape"]),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      phone.on = false;
      window.matchMedia = originalMatchMedia;
      resetPortraitWhileOpenForTests();
    }
  });
});
