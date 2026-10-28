// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyzeSongRequest,
  AnalyzeSongResult,
  ProposedSignatureMarker,
  ProposedTempoMarker,
  KeyChangeInput,
  SectionChange,
  TempoReading,
} from "@libretracks/shared/desktopApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

/**
 * From the user's side: the click and the harmonic tracks are found by name,
 * the proposal is shown for review, and Apply sends exactly what the review
 * shows, in one call (one undo).
 */
type TempoChange = {
  tempoMarkers: ProposedTempoMarker[];
  signatureMarkers: ProposedSignatureMarker[];
};
const analyzeSong = vi.fn<(request: AnalyzeSongRequest) => Promise<AnalyzeSongResult>>();
const listenToSongAnalysisProgress = vi.fn(async () => () => {});
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

const downloadSpeechModel = vi.fn(async () => ({
  supported: true,
  downloaded: true,
  sizeBytes: 59_707_625,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  analyzeSong: (request: AnalyzeSongRequest) => analyzeSong(request),
  cancelAnalyzeSong: async () => {},
  listenToSongAnalysisProgress: () => listenToSongAnalysisProgress(),
  applySongAnalysis: (
    regionId: string,
    tempo: TempoChange | null,
    key: string | null,
    sections: SectionChange[] | null,
    keyChanges: KeyChangeInput[] | null,
  ) => applySongAnalysis(regionId, tempo, key, sections, keyChanges),
  seekTransport: async () => ({}) as TransportSnapshot,
  speechModelStatus: async () => ({ supported: true, downloaded: false, sizeBytes: 59_707_625 }),
  downloadSpeechModel: () => downloadSpeechModel(),
  listenToSpeechModelProgress: async () => () => {},
}));

const { SongAnalysisModal } = await import("./SongAnalysisModal");
const { useSongAnalysisStore } = await import("./songAnalysisStore");
const { useSongStore } = await import("../songStore");

const audioTrack = (id: string, name: string) =>
  ({ id, name, kind: "audio", depth: 0, parentTrackId: null }) as never;

const wholeSongClip = (id: string, trackId: string) =>
  ({
    id,
    trackId,
    filePath: `audio/${trackId}.wav`,
    timelineStartSeconds: 0,
    durationSeconds: 200,
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
      { id: "a", name: "First", startSeconds: 0, endSeconds: 100, key: null } as never,
      {
        id: "b",
        name: "Second",
        startSeconds: 100,
        endSeconds: 200,
        key: "C",
        transposeSemitones: 0,
      } as never,
    ],
    tracks: [
      audioTrack("keys", "Keys"),
      audioTrack("drums", "Drums"),
      audioTrack("click", "Click"),
      audioTrack("guide", "Guide"),
    ],
    clips: [
      wholeSongClip("c1", "keys"),
      wholeSongClip("c2", "drums"),
      wholeSongClip("c3", "click"),
      wholeSongClip("c4", "guide"),
    ],
    projectRevision: 1,
  };
}

/** A reading whose click holds its tempos: every level of detail is the same. */
function withLevels<R extends Pick<TempoReading, "analysis" | "proposal">>(
  reading: R,
): R & TempoReading {
  const level = { segments: reading.analysis.segments, proposal: reading.proposal };
  return { ...reading, simplified: level, initial: level };
}

function result(overrides: Partial<AnalyzeSongResult> = {}): AnalyzeSongResult {
  return {
    cancelled: false,
    regionId: "b",
    regionStartSeconds: 100,
    regionEndSeconds: 200,
    renderStartSeconds: 100,
    viewScale: 1,
    tempo: withLevels({
      analysis: {
        segments: [{ startSeconds: 0.5, bpm: 92, beatsPerBar: 6, beatUnit: 8, bars: 40 }],
        warnings: [{ seconds: 61, kind: "clickGap" }],
        beatCount: 240,
        downbeatKnown: true,
      },
      proposal: {
        tempoMarkers: [
          { startSeconds: 100.5, bpm: 92 },
        ],
        signatureMarkers: [
          { startSeconds: 100.5, signature: "6/8" },
        ],
        currentBpm: 120,
        currentSignature: "4/4",
        unchanged: false,
      },
      asEighths: null,
    }),
    key: {
      analysis: {
        key: "D",
        confidence: 0.2,
        alternative: null,
        relativeDoubt: false,
        tuningCents: -32,
        candidates: [{ key: "D", score: 0.8 }],
        sections: [],
      },
      currentKey: "C",
      transposeSemitones: 0,
    },
    guide: null,
    missingFiles: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSongStore.setState({ song: song() });
  useSongAnalysisStore.setState({ target: { regionId: "b", regionName: "Second" } });
});

afterEach(() => {
  cleanup();
  useSongAnalysisStore.setState({ target: null });
});

async function analyzeAndReview() {
  fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));
  await waitFor(() => expect(analyzeSong).toHaveBeenCalledTimes(1));
}

/** A click without accent: 142 as it sounds, 71 read as eighths. */
function unaccentedTempo(): AnalyzeSongResult["tempo"] {
  const reading = (bpm: number, at: number[]) =>
    withLevels({
      analysis: {
        segments: [{ startSeconds: 0, bpm, beatsPerBar: 4, beatUnit: 4, bars: 40 }],
        warnings: [{ seconds: 0, kind: "noAccent" as const }],
        beatCount: 160,
        downbeatKnown: false,
      },
      proposal: {
        tempoMarkers: [{ startSeconds: 100, bpm }],
        signatureMarkers: at.map((startSeconds) => ({
          startSeconds,
          signature: "4/4",
        })),
        currentBpm: 120,
        currentSignature: "4/4",
        unchanged: false,
      },
    });
  return { ...reading(142, [100, 150.7]), asEighths: reading(71, [100, 152.4]) };
}

describe("SongAnalysisModal", () => {
  it("renders nothing while closed", () => {
    useSongAnalysisStore.setState({ target: null });
    const { container } = render(<SongAnalysisModal onApplied={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("explains a marker conflict on apply and returns to the edited review", async () => {
    analyzeSong.mockResolvedValue(result());
    const raw = "audio engine error: song is invalid: markers are out of order: section_19 before section_20";
    applySongAnalysis.mockRejectedValueOnce(raw);
    const onApplied = vi.fn();
    render(<SongAnalysisModal onApplied={onApplied} />);
    await analyzeAndReview();
    fireEvent.change(await screen.findByLabelText("transport.songAnalysis.key"), {
      target: { value: "Bm" },
    });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));

    expect(await screen.findByText(/transport\.songAnalysis\.applyFailed.*sectionMarkersConflict/)).toBeTruthy();
    expect(screen.getByText(raw).closest("details")?.open).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("transport.songAnalysis.back"));
    expect((screen.getByLabelText("transport.songAnalysis.key") as HTMLSelectElement).value).toBe("Bm");
    expect(analyzeSong).toHaveBeenCalledTimes(1);
  });

  it("formats analysis errors and returns to setup", async () => {
    analyzeSong.mockRejectedValueOnce("An analysis is already running");
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    expect(await screen.findByText(/transport\.songAnalysis\.failed.*analysisAlreadyRunning/)).toBeTruthy();
    fireEvent.click(screen.getByText("transport.songAnalysis.back"));
    expect(screen.getByText("transport.songAnalysis.analyze")).toBeTruthy();
  });

  it("reports failure to subscribe to analysis progress", async () => {
    listenToSongAnalysisProgress.mockRejectedValueOnce(new Error("listener failed"));
    render(<SongAnalysisModal onApplied={() => {}} />);
    fireEvent.click(screen.getByText("transport.songAnalysis.analyze"));
    expect(await screen.findByText(/transport\.songAnalysis\.failed.*listener failed/)).toBeTruthy();
    expect(analyzeSong).not.toHaveBeenCalled();
  });

  it("reads the tempo from the click and the key from the harmonic tracks", async () => {
    analyzeSong.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);

    expect(
      (screen.getByLabelText("transport.songAnalysis.clickTrack") as HTMLSelectElement).value,
    ).toBe("click");
    await analyzeAndReview();
    // Drums and click stay out of the key; keys go in.
    expect(analyzeSong).toHaveBeenCalledWith({
      regionId: "b",
      clickTrackIds: ["click"],
      musicTempoTrackIds: [],
      keyTrackIds: ["keys"],
      guideTrackIds: ["guide"],
    });
    await screen.findByText("transport.songAnalysis.warning.clickGap");
    // Positions are read from the song start: 1:01.0, not 2:41.0.
    expect(screen.getByText("1:01.0")).toBeTruthy();
    expect(screen.getByText(/transport\.songAnalysis\.tuningFlat.*32/)).toBeTruthy();
  });

  it("applies tempo, meter and key in one call, edits included", async () => {
    analyzeSong.mockResolvedValue(result());
    const snapshot = { projectRevision: 2 } as TransportSnapshot;
    applySongAnalysis.mockResolvedValue(snapshot);
    const onApplied = vi.fn();
    render(<SongAnalysisModal onApplied={onApplied} />);
    await analyzeAndReview();

    const bpmInput = await screen.findByDisplayValue("92");
    fireEvent.change(bpmInput, { target: { value: "92,5" } });
    fireEvent.change(screen.getByLabelText("transport.songAnalysis.key"), {
      target: { value: "Bm" },
    });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis).toHaveBeenCalledWith(
      "b",
      {
        tempoMarkers: [
          { startSeconds: 100.5, bpm: 92.5 },
        ],
        signatureMarkers: [
          { startSeconds: 100.5, signature: "6/8" },
        ],
      },
      "Bm",
      null,
      null,
    );
    expect(onApplied).toHaveBeenCalledWith(snapshot);
    await screen.findByText("transport.songAnalysis.applied");
  });

  it("can analyze only the key, and applies only the key", async () => {
    analyzeSong.mockResolvedValue(result({ tempo: null }));
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    fireEvent.change(screen.getByLabelText("transport.songAnalysis.clickTrack"), {
      target: { value: "" },
    });
    await analyzeAndReview();
    expect(analyzeSong.mock.calls[0][0].clickTrackIds).toEqual([]);

    await screen.findByLabelText("transport.songAnalysis.key");
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledWith("b", null, "D", null, null));
  });

  it("leaves the key alone when it is unticked", async () => {
    analyzeSong.mockResolvedValue(result());
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    fireEvent.click(await screen.findByLabelText("transport.songAnalysis.applyKey"));
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis.mock.calls[0][2]).toBeNull();
  });

  it("without a click track, estimates the tempo from the music", async () => {
    const noClick = song();
    noClick.tracks = noClick.tracks.filter((track) => track.id !== "click");
    noClick.clips = noClick.clips.filter((clip) => clip.trackId !== "click");
    useSongStore.setState({ song: noClick });
    const estimated = result();
    estimated.tempo!.analysis.warnings = [{ seconds: 0, kind: "estimatedWithoutClick" }];
    analyzeSong.mockResolvedValue(estimated);
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);

    expect(
      (screen.getByLabelText("transport.songAnalysis.clickTrack") as HTMLSelectElement).value,
    ).toBe("__music__");
    await analyzeAndReview();
    // Drums count for the tempo, though not for the key.
    expect(analyzeSong.mock.calls[0][0]).toMatchObject({
      clickTrackIds: [],
      musicTempoTrackIds: ["keys", "drums"],
    });

    await screen.findByText(/transport\.songAnalysis\.estimatedNotice/);
    // Estimated at double: halve it.
    fireEvent.click(screen.getByText("÷2"));
    expect(screen.getByDisplayValue("46")).toBeTruthy();
    // The meter is a guess: not ticked unless the user asks.
    const meterBox = screen.getByLabelText("transport.songAnalysis.applySignature") as HTMLInputElement;
    expect(meterBox.checked).toBe(false);
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    const tempo = applySongAnalysis.mock.calls[0][1];
    expect(tempo?.tempoMarkers[0].bpm).toBe(46);
    // Meter left as it is: none inside the song today.
    expect(tempo?.signatureMarkers).toEqual([]);
  });

  it("places the guide's markers and asks about the unknown announcements", async () => {
    const group = (labels: string[], transcript: string | null, start: number, end: number, occurrences = 1) => ({
      labels,
      transcript,
      matchCost: null,
      occurrences,
      firstStartSeconds: start,
      firstEndSeconds: end,
    });
    analyzeSong.mockResolvedValue(
      result({
        tempo: null,
        key: null,
        guide: {
          speechRecognition: true,
          analysis: {
            announcements: [
              { startSeconds: 4.8, endSeconds: 5.3, group: 0 },
              { startSeconds: 11.9, endSeconds: 12.4, group: 1 },
              { startSeconds: 24.6, endSeconds: 25.1, group: 0 },
              { startSeconds: 30.0, endSeconds: 31.2, group: 2 },
              { startSeconds: 40.0, endSeconds: 41.0, group: 3 },
            ],
            groups: [
              group(["chorus_2"], "Coro dos.", 4.8, 5.3, 2),
              group([], "Repite.", 11.9, 12.4),
              group(["verse_3", "drums_in"], "Verso 3, entra batería.", 30.0, 31.2),
              group(["count"], "Uno, dos, tres, cuatro.", 40, 41),
            ],
          },
        },
      }),
    );
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    expect(
      (screen.getByLabelText("transport.songAnalysis.guideTrack") as HTMLSelectElement).value,
    ).toBe("guide");
    await analyzeAndReview();

    // What recognition heard is shown; only "Repite" is left to the user.
    await screen.findByText("«Verso 3, entra batería.»");
    expect(screen.getByText(/transport\.songAnalysis\.unrecognised.*"count":1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/transport\.songAnalysis\.sectionFor.*0:11\.9/), {
      target: { value: "verse:1" },
    });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));

    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    // 120 BPM 4/4: bars every 2 s. Song at 100 s; ends at 105.3, 112.4,
    // 125.1 and 131.2; the count-in is ignored.
    const sections = applySongAnalysis.mock.calls[0][3] ?? [];
    expect(sections.map((s) => [s.startSeconds, s.kind, s.variant])).toEqual([
      [106, "chorus", 2],
      [114, "verse", 1],
      [126, "chorus", 2],
      [132, "verse", 3],
      [132, "drums_in", null],
    ]);
    expect(sections[0].name).toMatch(/markerKind\.chorus.* 2$/);
    expect(applySongAnalysis.mock.calls[0][1]).toBeNull();
    expect(applySongAnalysis.mock.calls[0][2]).toBeNull();
  });

  it("offers to download speech recognition when a guide is chosen", async () => {
    render(<SongAnalysisModal onApplied={() => {}} />);
    await screen.findByText(/transport\.songAnalysis\.speechMissing/);
    fireEvent.click(screen.getByText(/transport\.songAnalysis\.speechDownload/));
    await screen.findByText("transport.songAnalysis.speechReady");
    expect(downloadSpeechModel).toHaveBeenCalledTimes(1);
  });

  it("÷2 and ×2 swap a click without accent between its two readings", async () => {
    analyzeSong.mockResolvedValue(result({ tempo: unaccentedTempo() }));
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();

    // Nothing names the tempo: the click as it sounds.
    expect(await screen.findByDisplayValue("142")).toBeTruthy();
    expect(screen.getByText("0:50.7")).toBeTruthy();
    // Its bars come from the eighths reading, not 142 halved in place.
    fireEvent.click(screen.getByText("÷2"));
    expect(await screen.findByDisplayValue("71")).toBeTruthy();
    expect(screen.getByText("0:52.4")).toBeTruthy();
    expect(screen.queryByText("0:50.7")).toBeNull();
    fireEvent.click(screen.getByText("×2"));
    expect(await screen.findByDisplayValue("142")).toBeTruthy();
    // Past the two readings it scales.
    fireEvent.click(screen.getByText("×2"));
    expect(await screen.findByDisplayValue("284")).toBeTruthy();
  });

  it("follows the click first and offers fewer tempo changes", async () => {
    // A click that follows the band: three tempos bar by bar, or one
    // simplified, or only the first.
    const segment = (startSeconds: number, bpm: number, bars: number) => ({
      startSeconds,
      bpm,
      beatsPerBar: 4,
      beatUnit: 4,
      bars,
    });
    const proposal = (bpms: number[]) => ({
      tempoMarkers: bpms.map((bpm, index) => ({
        startSeconds: 100 + index * 10,
        bpm,
      })),
      signatureMarkers: [{ startSeconds: 100, signature: "4/4" }],
      currentBpm: 120,
      currentSignature: "4/4",
      unchanged: false,
    });
    const follow = [segment(0, 71, 8), segment(10, 56, 1), segment(20, 63.5, 1)];
    analyzeSong.mockResolvedValue(
      result({
        tempo: {
          analysis: { segments: follow, warnings: [], beatCount: 40, downbeatKnown: true },
          proposal: proposal([71, 56, 63.5]),
          simplified: { segments: follow.slice(0, 2), proposal: proposal([71, 59.4]) },
          initial: { segments: follow.slice(0, 1), proposal: proposal([71]) },
          asEighths: null,
        },
      }),
    );
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();

    expect(await screen.findByDisplayValue("56")).toBeTruthy();
    expect(screen.getByDisplayValue("63.5")).toBeTruthy();
    const options = screen.getAllByRole("radio").map((radio) => radio.parentElement?.textContent);
    expect(options.map((text) => text?.trim())).toEqual([
      "transport.songAnalysis.detail.follow",
      "transport.songAnalysis.detail.simplified",
      "transport.songAnalysis.detail.initial",
    ]);
    fireEvent.click(screen.getByLabelText("transport.songAnalysis.detail.simplified"));
    expect(await screen.findByDisplayValue("59.4")).toBeTruthy();
    expect(screen.queryByDisplayValue("56")).toBeNull();
    fireEvent.click(screen.getByLabelText("transport.songAnalysis.detail.initial"));
    await waitFor(() => expect(screen.queryByDisplayValue("56")).toBeNull());
    expect(screen.getByDisplayValue("71")).toBeTruthy();
    expect(screen.queryByDisplayValue("59.4")).toBeNull();
  });

  it("starts on the eighths reading when the song's name says its tempo", async () => {
    const named = song();
    named.regions[1] = { ...named.regions[1], name: "Digno de Adorar-MSM-D-71bpm" };
    useSongStore.setState({ song: named });
    analyzeSong.mockResolvedValue(result({ tempo: unaccentedTempo() }));
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();

    expect(await screen.findByDisplayValue("71")).toBeTruthy();
    expect(screen.getByText("0:52.4")).toBeTruthy();
  });

  it("will not apply an invalid value", async () => {
    analyzeSong.mockResolvedValue(result());
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();

    const meterInput = await screen.findByDisplayValue("6/8");
    fireEvent.change(meterInput, { target: { value: "6/7" } });
    expect(
      screen.getByText("transport.songAnalysis.apply").closest("button")?.disabled,
    ).toBe(true);
  });

  const modulating = () =>
    result({
      tempo: null,
      key: {
        analysis: {
          key: "E",
          confidence: 0.12,
          alternative: null,
          relativeDoubt: false,
          tuningCents: 0,
          candidates: [],
          sections: [
            { startSeconds: 0, key: "D" },
            { startSeconds: 60, key: "E" },
          ],
        },
        currentKey: "A",
        transposeSemitones: 0,
      },
    });

  it("applies each key stretch of a song that modulates as its key changes", async () => {
    analyzeSong.mockResolvedValue(modulating());
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    // One select per stretch; the first is the key the song starts in.
    const later = (await screen.findByLabelText(
      /transport\.songAnalysis\.keyAt.*1:00\.0/,
    )) as HTMLSelectElement;
    expect(later.value).toBe("E");
    fireEvent.change(later, { target: { value: "F" } });
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    const [, , key, , keyChanges] = applySongAnalysis.mock.calls[0];
    expect(key).toBe("D");
    // 60 s from the start of song "b", which starts at 100 s on the timeline.
    expect(keyChanges).toEqual([{ startSeconds: 160, key: "F" }]);
  });

  it("applies the key changes of a song that already has its starting key", async () => {
    // Eres Todopoderoso: already in D, so the key itself is unchanged, but the
    // last chorus in E was missing. The key part must come ticked anyway.
    const current = song();
    useSongStore.setState({
      song: {
        ...current,
        regions: current.regions.map((r) => (r.id === "b" ? { ...r, key: "D" } : r)),
      },
    });
    const analysed = modulating();
    analysed.key = { ...analysed.key!, currentKey: "D", analysis: { ...analysed.key!.analysis, key: "D" } };
    analyzeSong.mockResolvedValue(analysed);
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    await screen.findByLabelText(/transport\.songAnalysis\.keyAt.*1:00\.0/);
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis.mock.calls[0][2]).toBe("D");
    expect(applySongAnalysis.mock.calls[0][4]).toEqual([{ startSeconds: 160, key: "E" }]);
  });

  it("without the key changes, says where it modulates and proposes the longest key", async () => {
    analyzeSong.mockResolvedValue(modulating());
    applySongAnalysis.mockResolvedValue({} as TransportSnapshot);
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    fireEvent.click(await screen.findByText(/transport\.songAnalysis\.applyKeyChanges/));
    await screen.findByText(/transport\.songAnalysis\.keyModulates.*D · 0:00\.0 → E · 1:00\.0/);
    expect(
      (screen.getByLabelText("transport.songAnalysis.key") as HTMLSelectElement).value,
    ).toBe("E");
    fireEvent.click(screen.getByText("transport.songAnalysis.apply"));
    await waitFor(() => expect(applySongAnalysis).toHaveBeenCalledTimes(1));
    expect(applySongAnalysis.mock.calls[0][2]).toBe("E");
    expect(applySongAnalysis.mock.calls[0][4]).toBeNull();
  });

  it("offers the relative key when the call is close", async () => {
    analyzeSong.mockResolvedValue(
      result({
        key: {
          analysis: {
            key: "C",
            confidence: 0.03,
            alternative: "Am",
            relativeDoubt: true,
            tuningCents: 0,
            candidates: [],
            sections: [],
          },
          currentKey: null,
          transposeSemitones: 2,
        },
      }),
    );
    render(<SongAnalysisModal onApplied={() => {}} />);
    await analyzeAndReview();
    await screen.findByText(/transport\.songAnalysis\.keyRelativeDoubt.*Am/);
    // Transposed +2, it sounds a tone up.
    expect(screen.getByText(/transport\.songAnalysis\.keyTransposed.*"key":"D"/)).toBeTruthy();
  });
});
