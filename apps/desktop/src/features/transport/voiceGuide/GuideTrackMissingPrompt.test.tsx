import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";
import { useSongStore } from "../songStore";
import { GuideTrackMissingPrompt } from "./GuideTrackMissingPrompt";
import { INITIAL_GUIDE_TRACK_PROMPT_STATE, useGuideTrackPromptStore } from "./guideTrackPrompt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const api = vi.hoisted(() => ({
  updateTrackGuide: vi.fn(),
  getSongView: vi.fn(),
}));
vi.mock("../desktopApi", () => api);

/** Dos canciones; la segunda ya tiene guía. */
function songView(firstHasGuide = false): SongView {
  return {
    regions: [
      { id: "r1", name: "Way Maker", startSeconds: 0, endSeconds: 10, hasGuideTrack: firstHasGuide },
      { id: "r2", name: "Gracia", startSeconds: 10, endSeconds: 20, hasGuideTrack: true },
    ],
    tracks: [
      { id: "voz", name: "Voz guía grabada", kind: "audio", isGuide: firstHasGuide },
      { id: "keys", name: "Keys", kind: "audio" },
      { id: "g2", name: "Guía", kind: "audio", isGuide: true },
    ],
    clips: [
      { id: "c1", trackId: "voz", timelineStartSeconds: 0, durationSeconds: 10 },
      { id: "c2", trackId: "keys", timelineStartSeconds: 0, durationSeconds: 10 },
      { id: "c3", trackId: "g2", timelineStartSeconds: 10, durationSeconds: 10 },
    ],
  } as unknown as SongView;
}

const ON = { voiceGuideEnabled: true, voiceGuideJumpsOnly: true };

describe("GuideTrackMissingPrompt", () => {
  beforeEach(() => {
    useSongStore.setState({ song: songView() });
    useGuideTrackPromptStore.setState({ ...INITIAL_GUIDE_TRACK_PROMPT_STATE });
    api.updateTrackGuide.mockReset().mockResolvedValue({});
    api.getSongView.mockReset().mockResolvedValue(songView(true));
  });

  it("stays hidden unless the voice guide is on and only on jumps", () => {
    const { rerender } = render(
      <GuideTrackMissingPrompt settings={{ voiceGuideEnabled: true, voiceGuideJumpsOnly: false }} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <GuideTrackMissingPrompt settings={{ voiceGuideEnabled: false, voiceGuideJumpsOnly: true }} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists only the songs without a guide, with that song's tracks to choose from", () => {
    render(<GuideTrackMissingPrompt settings={ON} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Way Maker" }) as HTMLSelectElement;
    expect(screen.queryByRole("combobox", { name: "Gracia" })).toBeNull();
    // Solo las pistas que suenan en esa canción.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "voz", "keys"]);
  });

  it("marks the chosen track as the guide and shows done once every song has one", async () => {
    render(<GuideTrackMissingPrompt settings={ON} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Way Maker" }), {
      target: { value: "voz" },
    });
    await waitFor(() =>
      expect(api.updateTrackGuide).toHaveBeenCalledWith({ trackId: "voz", guide: true }),
    );
    await screen.findByText("transport.guidePrompt.done");
    expect(screen.getByText("transport.guidePrompt.allSet")).toBeTruthy();
    fireEvent.click(screen.getByText("transport.guidePrompt.done"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not nag again for a song the user put off, until asked or re-enabled", () => {
    const { rerender } = render(<GuideTrackMissingPrompt settings={ON} />);
    fireEvent.click(screen.getByText("transport.guidePrompt.later"));
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => useGuideTrackPromptStore.getState().reopen());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("transport.guidePrompt.later"));

    rerender(<GuideTrackMissingPrompt settings={{ ...ON, voiceGuideJumpsOnly: false }} />);
    rerender(<GuideTrackMissingPrompt settings={ON} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("warns again when a new song without a guide shows up", () => {
    render(<GuideTrackMissingPrompt settings={ON} />);
    fireEvent.click(screen.getByText("transport.guidePrompt.later"));
    act(() =>
      useSongStore.setState((state) => ({
        song: {
          ...state.song!,
          regions: [
            ...state.song!.regions,
            { id: "r3", name: "Nueva", startSeconds: 20, endSeconds: 30, hasGuideTrack: false },
          ],
        } as SongView,
      })),
    );
    expect(screen.getByRole("combobox", { name: "Nueva" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Way Maker" })).toBeNull();
  });
});
