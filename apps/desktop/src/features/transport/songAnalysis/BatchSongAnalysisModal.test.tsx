// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyzeSongRequest,
  AnalyzeSongResult,
  KeyChangeInput,
  ProposedSignatureMarker,
  ProposedTempoMarker,
  SectionChange,
  TempoReading,
} from "@libretracks/shared/desktopApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

/**
 * "Analizar todas las canciones" from the user's side: every song is analysed
 * with its own preselected tracks, one after another; then each can be
 * reviewed in the single-song dialog, or all applied as proposed (one apply
 * per song, hand-placed markers kept).
 */
type TempoChange = {
  tempoMarkers: ProposedTempoMarker[];
  signatureMarkers: ProposedSignatureMarker[];
};
const analyzeSong = vi.fn<(request: AnalyzeSongRequest) => Promise<AnalyzeSongResult>>();
const cancelAnalyzeSong = vi.fn(async () => {});
const getSongView = vi.fn<() => Promise<SongView | null>>();
const applySongAnalysis =
  vi.fn<
    (
      regionId: string,
      tempo: TempoChange | null,
      key: string | null,
      sections?: SectionChange[] | null,
      keyChanges?: KeyChangeInput[] | null,
    ) => Promise<TransportSnapshot>
  >();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  analyzeSong: (request: AnalyzeSongRequest) => analyzeSong(request),
  cancelAnalyzeSong: () => cancelAnalyzeSong(),
  getSongView: () => getSongView(),
  listenToSongAnalysisProgress: async () => () => {},
  applySongAnalysis: (
    regionId: string,
    tempo: TempoChange | null,
    key: string | null,
    sections: SectionChange[] | null,
    keyChanges: KeyChangeInput[] | null,
  ) => applySongAnalysis(regionId, tempo, key, sections, keyChanges),
  seekTransport: async () => ({}) as TransportSnapshot,
  speechModelStatus: async () => ({ supported: true, downloaded: true, sizeBytes: 1 }),
  downloadSpeechModel: async () => ({ supported: true, downloaded: true, sizeBytes: 1 }),
  listenToSpeechModelProgress: async () => () => {},
}));

const { BatchSongAnalysisModal } = await import("./BatchSongAnalysisModal");
const { useBatchSongAnalysisStore } = await import("./songAnalysisStore");
const { useSongStore } = await import("../songStore");

const audioTrack = (id: string, name: string) =>
  ({ id, name, kind: "audio", depth: 0, parentTrackId: null }) as never;

const clip = (id: string, trackId: string, start: number) =>
  ({
    id,
    trackId,
    filePath: `audio/${trackId}.wav`,
    timelineStartSeconds: start,
    durationSeconds: 100,
  }) as never;

/** Three songs: "Uno" and "Dos" have a click and keys, "Silencio" nothing. */
function song(sectionMarkers: SongView["sectionMarkers"] = []): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers,
    regions: [
      { id: "a", name: "Uno", startSeconds: 0, endSeconds: 100, key: "C" } as never,
      { id: "b", name: "Dos", startSeconds: 100, endSeconds: 200, key: "C" } as never,
      { id: "c", name: "Silencio", startSeconds: 200, endSeconds: 300, key: null } as never,
    ],
    tracks: [audioTrack("keys", "Keys"), audioTrack("click", "Click"), audioTrack("guide", "Guide")],
    clips: [
      clip("k1", "keys", 0),
      clip("k2", "keys", 100),
      clip("c1", "click", 0),
      clip("c2", "click", 100),
      clip("g1", "guide", 0),
      clip("g2", "guide", 100),
    ],
    projectRevision: 1,
  };
}

function withLevels<R extends Pick<TempoReading, "analysis" | "proposal">>(
  reading: R,
): R & TempoReading {
  const level = { segments: reading.analysis.segments, proposal: reading.proposal };
  return { ...reading, simplified: level, initial: level };
}

function result(regionId: string, start: number, bpm: number, key: string): AnalyzeSongResult {
  return {
    cancelled: false,
    regionId,
    regionStartSeconds: start,
    regionEndSeconds: start + 100,
    renderStartSeconds: start,
    viewScale: 1,
    tempo: {
      ...withLevels({
        analysis: {
          segments: [{ startSeconds: 0, bpm, beatsPerBar: 4, beatUnit: 4, bars: 40 }],
          warnings: [],
          beatCount: 160,
          downbeatKnown: true,
        },
        proposal: {
          tempoMarkers: [{ startSeconds: start, bpm }],
          signatureMarkers: [{ startSeconds: start, signature: "4/4" }],
          currentBpm: 120,
          currentSignature: "4/4",
          unchanged: false,
        },
      }),
      asEighths: null,
    },
    key: {
      analysis: {
        key,
        confidence: 0.8,
        alternative: null,
        relativeDoubt: false,
        tuningCents: 0,
        candidates: [{ key, score: 0.8 }],
        sections: [],
      },
      currentKey: "C",
      transposeSemitones: 0,
    },
    guide: {
      analysis: {
        announcements: [{ startSeconds: 4, endSeconds: 5, group: 0 }],
        groups: [
          {
            labels: ["chorus"],
            transcript: "Coro",
            matchCost: null,
            occurrences: 1,
            firstStartSeconds: 4,
            firstEndSeconds: 5,
          },
        ],
      },
      speechRecognition: true,
    },
    missingFiles: [],
  };
}

const results: Record<string, AnalyzeSongResult> = {
  a: result("a", 0, 98, "D"),
  b: result("b", 100, 140, "G"),
};

beforeEach(() => {
  vi.clearAllMocks();
  analyzeSong.mockImplementation(async (request) => results[request.regionId]);
  applySongAnalysis.mockImplementation(async () => ({}) as TransportSnapshot);
  getSongView.mockImplementation(async () => useSongStore.getState().song);
  useSongStore.setState({ song: song() });
  useBatchSongAnalysisStore.setState({ open: true });
});

afterEach(() => {
  cleanup();
  useBatchSongAnalysisStore.setState({ open: false });
});

async function analyzeAll() {
  fireEvent.click(screen.getByText(/transport\.songAnalysis\.batch\.analyze /));
  return screen.findByText(/transport\.songAnalysis\.batch\.applyAll/);
}

const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("BatchSongAnalysisModal", () => {
  it("renders nothing while closed", () => {
    useBatchSongAnalysisStore.setState({ open: false });
    const { container } = render(<BatchSongAnalysisModal onApplied={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("analyses each song with its own tracks, in order, skipping songs with nothing to read", async () => {
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    expect((screen.getByLabelText("Silencio") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/batch\.analyze .*"count":2/)).toBeTruthy();

    await analyzeAll();

    expect(analyzeSong.mock.calls.map(([request]) => request)).toEqual([
      {
        regionId: "a",
        clickTrackIds: ["click"],
        musicTempoTrackIds: [],
        keyTrackIds: ["keys"],
        guideTrackIds: ["guide"],
      },
      {
        regionId: "b",
        clickTrackIds: ["click"],
        musicTempoTrackIds: [],
        keyTrackIds: ["keys"],
        guideTrackIds: ["guide"],
      },
    ]);
    expect(within(row("Uno")).getByText(/batch\.tempo .*"bpm":"98"/)).toBeTruthy();
    expect(within(row("Dos")).getByText(/batch\.key .*"key":"G"/)).toBeTruthy();
  });

  it("applies every song as proposed, one apply (one undo) per song", async () => {
    const onApplied = vi.fn();
    render(<BatchSongAnalysisModal onApplied={onApplied} />);
    await analyzeAll();
    fireEvent.click(screen.getByText(/batch\.applyAll .*"count":2/));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(2));
    const [first, second] = applySongAnalysis.mock.calls;
    expect(first[0]).toBe("a");
    expect(first[1]?.tempoMarkers).toEqual([{ startSeconds: 0, bpm: 98 }]);
    expect(first[2]).toBe("D");
    expect(first[3]?.map((section) => section.kind)).toEqual(["chorus"]);
    expect(second[0]).toBe("b");
    expect(second[1]?.tempoMarkers).toEqual([{ startSeconds: 100, bpm: 140 }]);
    expect(second[2]).toBe("G");
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(await within(row("Uno")).findByText("transport.songAnalysis.batch.statusApplied")).toBeTruthy();
    // Nothing left: no "apply all (0)" button, a notice instead.
    expect(screen.queryByText(/batch\.applyAll/)).toBeNull();
    expect(screen.getByText("transport.songAnalysis.batch.allApplied")).toBeTruthy();
  });

  it("applies each song where it is after the songs before it moved it", async () => {
    // Applying "Uno"'s tempo realigns the songs after it: "Dos" now starts
    // 2 s later. The song store only catches up later (it refetches after
    // the snapshot renders), so the batch must ask the backend.
    const moved = song();
    moved.regions = moved.regions.map((region) =>
      region.id === "a"
        ? { ...region, endSeconds: 102 }
        : { ...region, startSeconds: region.startSeconds + 2, endSeconds: region.endSeconds + 2 },
    );
    moved.clips = moved.clips.map((c) =>
      (c as { timelineStartSeconds: number }).timelineStartSeconds >= 100
        ? ({ ...(c as object), timelineStartSeconds: 102 } as never)
        : c,
    );
    applySongAnalysis.mockImplementation(async () => {
      getSongView.mockImplementation(async () => moved);
      return {} as TransportSnapshot;
    });
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    await analyzeAll();
    fireEvent.click(screen.getByText(/batch\.applyAll/));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(2));
    const second = applySongAnalysis.mock.calls[1];
    expect(second[0]).toBe("b");
    expect(second[1]?.tempoMarkers).toEqual([{ startSeconds: 102, bpm: 140 }]);
    // "Coro" said 4-5 s into the song: on the first downbeat after it of
    // its 140 BPM grid (bar 3, 12/7 s a bar) counted from where it is now.
    expect(second[3]?.[0].startSeconds).toBeCloseTo(102 + ((4 * 60) / 140) * 3, 3);
  });

  it("keeps the markers a song already has when applying them all", async () => {
    useSongStore.setState({
      song: song([{ id: "m", name: "Verso", startSeconds: 110, kind: "verse" } as never]),
    });
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    await analyzeAll();
    expect(within(row("Dos")).getByText(/batch\.keepsMarkers .*"count":1/)).toBeTruthy();
    fireEvent.click(screen.getByText(/batch\.applyAll/));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(2));
    expect(applySongAnalysis.mock.calls[0][3]).not.toBeNull();
    expect(applySongAnalysis.mock.calls[1][0]).toBe("b");
    expect(applySongAnalysis.mock.calls[1][3]).toBeNull();
  });

  it("reviews one song in the song dialog and applies the rest without it", async () => {
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    await analyzeAll();
    fireEvent.click(within(row("Uno")).getByText("transport.songAnalysis.batch.review"));

    // The single-song review, already analysed: no second analysis.
    fireEvent.change(await screen.findByLabelText("transport.songAnalysis.key"), {
      target: { value: "Bm" },
    });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis.mock.calls[0][2]).toBe("Bm");
    expect(analyzeSong).toHaveBeenCalledTimes(2);

    // Back on the list: "Uno" is done, only "Dos" is left to apply.
    expect(await within(row("Uno")).findByText("transport.songAnalysis.batch.statusApplied")).toBeTruthy();
    fireEvent.click(screen.getByText(/batch\.applyAll .*"count":1/));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(2));
    expect(applySongAnalysis.mock.calls[1][0]).toBe("b");
  });

  it("leaving a review without applying returns to the list untouched", async () => {
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    await analyzeAll();
    fireEvent.click(within(row("Dos")).getByText("transport.songAnalysis.batch.review"));
    fireEvent.click(await screen.findByText("transport.songAnalysis.back"));
    expect(await screen.findByText(/batch\.applyAll .*"count":2/)).toBeTruthy();
    expect(applySongAnalysis).not.toHaveBeenCalled();
  });

  it("stopping keeps what was analysed and leaves the rest unanalysed", async () => {
    let release: (value: AnalyzeSongResult) => void = () => {};
    analyzeSong.mockImplementationOnce(async (request) => results[request.regionId]);
    analyzeSong.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    fireEvent.click(screen.getByText(/transport\.songAnalysis\.batch\.analyze /));
    fireEvent.click(await screen.findByText("transport.songAnalysis.stop"));
    await waitFor(() => expect(cancelAnalyzeSong).toHaveBeenCalled());
    release({ ...results.b, cancelled: true });

    expect(await screen.findByText("transport.songAnalysis.batch.stopped")).toBeTruthy();
    expect(within(row("Dos")).getByText("transport.songAnalysis.batch.statusPending")).toBeTruthy();
    expect(screen.getByText(/batch\.applyAll .*"count":1/)).toBeTruthy();
  });

  it("reports a song that fails and carries on with the next", async () => {
    analyzeSong.mockImplementationOnce(async () => {
      throw new Error("Nothing to analyze");
    });
    render(<BatchSongAnalysisModal onApplied={() => {}} />);
    await analyzeAll();
    expect(within(row("Uno")).getByText("transport.songAnalysis.nothingToAnalyze")).toBeTruthy();
    expect(within(row("Dos")).getByText(/batch\.tempo .*"bpm":"140"/)).toBeTruthy();
  });
});
