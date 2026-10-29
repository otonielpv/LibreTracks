// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RenderAudioProgressEvent,
  RenderSongAudioRequest,
  RenderSongAudioResult,
} from "@libretracks/shared/desktopApi";
import type { SongView } from "@libretracks/shared/models";
import { recordProductEvent } from "../../telemetry/telemetry";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));

/**
 * The render modal is the whole feature from the user's side: tick the
 * tracks that go in, press Render. What must hold is that the request names
 * exactly the ticked tracks — a drummer who gets the drums back in their
 * rehearsal mix has been sent the wrong file.
 */
const renderSongAudio = vi.fn<(request: RenderSongAudioRequest) => Promise<RenderSongAudioResult>>();
const cancelRenderSongAudio = vi.fn(async () => {});
let progressHandler: ((event: RenderAudioProgressEvent) => void) | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  renderSongAudio: (request: RenderSongAudioRequest) => renderSongAudio(request),
  cancelRenderSongAudio: () => cancelRenderSongAudio(),
  listenToRenderAudioProgress: async (handler: (event: RenderAudioProgressEvent) => void) => {
    progressHandler = handler;
    return () => {
      progressHandler = null;
    };
  },
}));

const { RenderSongModal } = await import("./RenderSongModal");
const { useRenderStore } = await import("./renderStore");
const { useSongStore } = await import("../songStore");

function song(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 200,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [{ id: "r1", name: "Oceans", startSeconds: 0, endSeconds: 100 } as never],
    tracks: [
      { id: "d", name: "Drums", kind: "audio", depth: 0 } as never,
      { id: "b", name: "Bass", kind: "audio", depth: 0 } as never,
      { id: "k", name: "Keys", kind: "audio", depth: 0 } as never,
    ],
    clips: [
      { id: "c1", trackId: "d", timelineStartSeconds: 0, durationSeconds: 100 } as never,
      { id: "c2", trackId: "b", timelineStartSeconds: 0, durationSeconds: 100 } as never,
      { id: "c3", trackId: "k", timelineStartSeconds: 0, durationSeconds: 100 } as never,
    ],
    projectRevision: 1,
  };
}

const saved: RenderSongAudioResult = {
  saved: true,
  cancelled: false,
  fileName: "Oceans.wav",
  fileCount: 1,
  missingFiles: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useSongStore.setState({ song: song() });
  useRenderStore.setState({ target: { regionId: "r1", regionName: "Oceans" } });
});

afterEach(() => {
  cleanup();
  useRenderStore.setState({ target: null });
});

describe("RenderSongModal", () => {
  it("renders nothing until a song is chosen", () => {
    useRenderStore.setState({ target: null });
    const { container } = render(<RenderSongModal />);
    expect(container.innerHTML).toBe("");
  });

  it("sends only the ticked tracks, in the chosen format", async () => {
    renderSongAudio.mockResolvedValue(saved);
    render(<RenderSongModal />);

    fireEvent.click(screen.getByLabelText("Drums"));
    fireEvent.change(screen.getByDisplayValue("transport.renderModal.formats.pcm24"), {
      target: { value: "pcm16" },
    });
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));

    await waitFor(() => expect(renderSongAudio).toHaveBeenCalledTimes(1));
    const request = renderSongAudio.mock.calls[0][0];
    expect(request.regionId).toBe("r1");
    expect(request.trackIds).toEqual(["b", "k"]);
    expect(request.mode).toBe("mix");
    expect(request.format).toBe("pcm16");
    expect(request.applyMixer).toBe(true);
    // The name says who it is for.
    expect(request.fileName).toContain("transport.renderModal.withoutFileName");
    expect(request.fileName).toContain("Drums");
    await screen.findByText(/transport.renderModal.saved/);
    expect(recordProductEvent).toHaveBeenCalledWith("feature_audio_render");
  });

  it("will not render an empty selection", () => {
    render(<RenderSongModal />);
    fireEvent.click(screen.getByText("transport.renderModal.selectNone"));
    expect((screen.getByText("transport.renderModal.confirm") as HTMLButtonElement).disabled).toBe(true);
    // The click alone is enough to render something.
    fireEvent.click(screen.getByText("transport.renderModal.includeMetronome"));
    expect((screen.getByText("transport.renderModal.confirm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("exports every song with independent track and cue pans", async () => {
    renderSongAudio.mockResolvedValue(saved);
    render(<RenderSongModal />);
    fireEvent.click(screen.getByText("transport.renderModal.scope_songs"));
    fireEvent.click(screen.getByText("transport.renderModal.includeMetronome"));
    fireEvent.click(screen.getByText("transport.renderModal.includeVoiceGuide"));
    fireEvent.change(screen.getByLabelText(/transport.renderModal.tracksPan/), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText(/transport.renderModal.metronomePan/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/transport.renderModal.voiceGuidePan/), { target: { value: "0.5" } });
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await waitFor(() => expect(renderSongAudio).toHaveBeenCalledTimes(1));
    expect(renderSongAudio.mock.calls[0][0]).toMatchObject({ scope: "songs", tracksPan: -1, metronomePan: 1, voiceGuidePan: 0.5 });
  });

  it("opens for the entire session and ignores pan when exporting mono", async () => {
    useRenderStore.setState({ target: { regionId: "", regionName: "" } });
    renderSongAudio.mockResolvedValue(saved);
    render(<RenderSongModal />);
    fireEvent.change(screen.getByLabelText(/transport.renderModal.tracksPan/), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText("transport.renderModal.channels"), { target: { value: "1" } });
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await waitFor(() => expect(renderSongAudio).toHaveBeenCalledTimes(1));
    expect(renderSongAudio.mock.calls[0][0]).toMatchObject({ scope: "session", trackIds: ["d", "b", "k"], tracksPan: 0 });
  });

  it("shows cue pan faders only when their app sources are included", () => {
    render(<RenderSongModal />);
    expect(screen.queryByLabelText("transport.renderModal.metronomePan")).toBeNull();
    expect(screen.queryByLabelText("transport.renderModal.voiceGuidePan")).toBeNull();
    fireEvent.click(screen.getByText("transport.renderModal.includeMetronome"));
    fireEvent.change(screen.getByLabelText("transport.renderModal.metronomePan"), { target: { value: "1" } });
    fireEvent.click(screen.getByText("transport.renderModal.includeVoiceGuide"));
    expect(screen.getByLabelText("transport.renderModal.voiceGuidePan")).toBeTruthy();
    fireEvent.click(screen.getByText("transport.renderModal.includeMetronome"));
    expect(screen.queryByLabelText("transport.renderModal.metronomePan")).toBeNull();
    fireEvent.click(screen.getByText("transport.renderModal.includeMetronome"));
    expect((screen.getByLabelText("transport.renderModal.metronomePan") as HTMLInputElement).value).toBe("1");
    fireEvent.doubleClick(screen.getByLabelText("transport.renderModal.metronomePan"));
    expect((screen.getByLabelText("transport.renderModal.metronomePan") as HTMLInputElement).value).toBe("0");
  });

  it("groups session tracks and toggles detected click and guide tracks together", async () => {
    const setlist = song();
    setlist.regions.push({ id: "r2", name: "Second", startSeconds: 100, endSeconds: 200 } as never);
    setlist.tracks.push(
      { id: "click1", name: "Click 1", kind: "audio", depth: 0 } as never,
      { id: "guide", name: "Guía", kind: "audio", depth: 0 } as never,
      { id: "shared", name: "Click", kind: "audio", depth: 0 } as never,
      { id: "loose", name: "Loose", kind: "audio", depth: 0 } as never,
    );
    setlist.clips.push(
      { id: "click1", trackId: "click1", timelineStartSeconds: 0, durationSeconds: 90 } as never,
      { id: "guide", trackId: "guide", timelineStartSeconds: 100, durationSeconds: 90 } as never,
      { id: "shared", trackId: "shared", timelineStartSeconds: 0, durationSeconds: 200 } as never,
      { id: "loose", trackId: "loose", timelineStartSeconds: 250, durationSeconds: 10 } as never,
    );
    useSongStore.setState({ song: setlist });
    useRenderStore.setState({ target: { regionId: "", regionName: "" } });
    renderSongAudio.mockResolvedValue(saved);
    render(<RenderSongModal />);
    expect(screen.getByRole("button", { name: /Oceans/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Second/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /transport.levelSongs.sharedTracks/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /transport.renderModal.outsideSongs/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Oceans/ }));
    const firstGroup = screen.getByRole("button", { name: /Oceans/ }).closest("li")!;
    expect(within(firstGroup).getByLabelText("Click 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Oceans" }));
    expect((within(firstGroup).getByLabelText("Drums") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Oceans" }));
    fireEvent.click(screen.getByText("transport.renderModal.removeCueTracks"));
    expect((screen.getByLabelText("Click") as HTMLInputElement).checked).toBe(false);
    expect((within(firstGroup).getByLabelText("Click 1") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText("transport.renderModal.includeCueTracks"));
    expect((screen.getByLabelText("Click") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText("transport.renderModal.removeCueTracks"));
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await waitFor(() => expect(renderSongAudio).toHaveBeenCalledTimes(1));
    expect(renderSongAudio.mock.calls[0][0].trackIds).toEqual(["d", "b", "k", "loose"]);
  });

  it("shows progress and can stop the render", async () => {
    let finish: (result: RenderSongAudioResult) => void = () => {};
    renderSongAudio.mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<RenderSongModal />);
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await waitFor(() => expect(progressHandler).not.toBeNull());
    act(() => progressHandler?.({ fraction: 0.42, stage: "rendering" }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

    fireEvent.click(screen.getByText("transport.renderModal.stop"));
    expect(cancelRenderSongAudio).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...saved, saved: false, cancelled: true, fileName: null }));
    // Back on the form, told what happened, choices intact.
    expect(screen.getByText("transport.renderModal.cancelled")).toBeTruthy();
    expect(recordProductEvent).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Drums") as HTMLInputElement).checked).toBe(true);
  });

  it("remembers the options for next time", async () => {
    renderSongAudio.mockResolvedValue(saved);
    render(<RenderSongModal />);
    fireEvent.click(screen.getByText("transport.renderModal.stemsTitle"));
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await waitFor(() => expect(renderSongAudio).toHaveBeenCalled());
    expect(renderSongAudio.mock.calls[0][0].mode).toBe("stems");
    cleanup();
    render(<RenderSongModal />);
    const stemsRadio = screen
      .getByText("transport.renderModal.stemsTitle")
      .closest("label")
      ?.querySelector("input");
    expect(stemsRadio?.checked).toBe(true);
  });

  it("reports a failure instead of closing", async () => {
    renderSongAudio.mockRejectedValue(new Error("disk full"));
    render(<RenderSongModal />);
    fireEvent.click(screen.getByText("transport.renderModal.confirm"));
    await screen.findByText(/disk full/);
  });
});
