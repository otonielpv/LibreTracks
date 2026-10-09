import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { useTransportStore } from "../store";
import { mergeTrackMix, useAutomationMixSync } from "./useAutomationMixSync";

const getSongViewMock = vi.fn<(options?: { includeWaveforms?: boolean }) => Promise<SongView | null>>();

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    getSongView: (options?: { includeWaveforms?: boolean }) => getSongViewMock(options),
  };
});

function song(muted: boolean, extra: Partial<SongView> = {}): SongView {
  return {
    id: "song",
    tracks: [
      { id: "drums", name: "Drums", muted, solo: false, volume: 1, pan: 0 },
      { id: "bass", name: "Bass", muted: false, solo: false, volume: 1, pan: 0 },
    ],
    clips: [],
    waveforms: [{ waveformKey: "kept" }],
    ...extra,
  } as unknown as SongView;
}

function snapshot(mixRevision: number): TransportSnapshot {
  return {
    playbackState: "playing",
    positionSeconds: 0,
    projectRevision: 3,
    mixRevision,
    isNativeRuntime: true,
  } as unknown as TransportSnapshot;
}

describe("mergeTrackMix", () => {
  it("takes only the mix fields and keeps the rest of the current song", () => {
    const current = song(true);
    const fresh = song(false, { waveforms: [] });
    const merged = mergeTrackMix(current, fresh);
    expect(merged?.tracks[0].muted).toBe(false);
    expect(merged?.waveforms).toBe(current.waveforms);
  });

  it("returns the same object when the mix did not change", () => {
    const current = song(true);
    expect(mergeTrackMix(current, song(true))).toBe(current);
  });
});

describe("useAutomationMixSync", () => {
  beforeEach(() => {
    getSongViewMock.mockReset();
    useSongStore.setState({ song: song(true) });
    useTransportStore.setState({ playback: snapshot(0) });
  });

  // The field report: mute by hand, a cue un-mutes, the red M stays lit
  // because nothing refetched the song.
  it("clears the red M when automation un-mutes the track", async () => {
    getSongViewMock.mockResolvedValue(song(false));
    renderHook(() => useAutomationMixSync());

    useTransportStore.setState({ playback: snapshot(1) });

    await waitFor(() =>
      expect(useSongStore.getState().song?.tracks[0].muted).toBe(false),
    );
    expect(getSongViewMock).toHaveBeenCalledWith({ includeWaveforms: false });
  });

  it("does not refetch when the mix revision is unchanged", () => {
    renderHook(() => useAutomationMixSync());
    useTransportStore.setState({ playback: { ...snapshot(0), positionSeconds: 5 } });
    expect(getSongViewMock).not.toHaveBeenCalled();
  });
});
