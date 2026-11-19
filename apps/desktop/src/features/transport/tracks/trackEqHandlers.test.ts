import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackEq, TrackSummary, TransportSnapshot } from "@libretracks/shared/models";

import { useTrackEqStore } from "../eq/trackEqStore";
import { defaultTrackEq } from "../eq/trackEqModel";
import { createTrackEqHandlers } from "./trackEqHandlers";

const audio = { id: "a", kind: "audio", eq: null } as unknown as TrackSummary;
const folder = { id: "f", kind: "folder", eq: null } as unknown as TrackSummary;

function setup(track: TrackSummary = audio) {
  let song = { projectRevision: 1, tracks: [track] } as unknown as SongView;
  const deps = {
    runAction: async (action: () => Promise<void>) => action(),
    setSong: (update: (previous: SongView | null) => SongView | null) => {
      song = update(song) as SongView;
    },
    applyPlaybackSnapshot: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
    findTrack: (id: string) => song.tracks.find((t) => t.id === id) ?? null,
    updateTrackEqRealtime: vi.fn(async (_args: { trackId: string; eq: TrackEq | null }) => undefined),
    setTrackEqAnalyzer: vi.fn(async (_trackId: string | null) => undefined),
    getTrackEqSpectrum: vi.fn(async () => [-20, -30] as number[]),
    commitTrackEqChange: vi.fn(
      async (_args: { trackId: string; eq: TrackEq | null }) => ({ projectRevision: 7 }) as TransportSnapshot,
    ),
  };
  return { handlers: createTrackEqHandlers(deps), deps, song: () => song };
}

beforeEach(() => useTrackEqStore.setState({ openTrackId: null }));

describe("createTrackEqHandlers", () => {
  it("opens the editor only for audio tracks", () => {
    const { handlers } = setup();
    handlers.open("a");
    expect(useTrackEqStore.getState().openTrackId).toBe("a");
    handlers.close();
    expect(useTrackEqStore.getState().openTrackId).toBeNull();
    const withFolder = setup(folder);
    withFolder.handlers.open("f");
    expect(useTrackEqStore.getState().openTrackId).toBeNull();
  });

  it("commit sanitizes, patches the song for every view and publishes the snapshot", async () => {
    const { handlers, deps, song } = setup();
    const wild: TrackEq = { ...defaultTrackEq(), bands: defaultTrackEq().bands.map((b) => ({ ...b, gainDb: 50 })) };
    await handlers.commit("a", wild);
    const sent = deps.commitTrackEqChange.mock.calls[0][0] as { eq: TrackEq };
    expect(sent.eq.bands.every((b) => b.gainDb === 18)).toBe(true);
    expect(song().tracks[0].eq?.bands[1].gainDb).toBe(18);
    expect(song().projectRevision).toBe(7);
    expect(deps.optimisticallyAppliedRevisionsRef.current.has(7)).toBe(true);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalled();
  });

  it("applyLive goes to the realtime command only", () => {
    const { handlers, deps } = setup();
    handlers.applyLive("a", defaultTrackEq());
    expect(deps.updateTrackEqRealtime).toHaveBeenCalledTimes(1);
    expect(deps.commitTrackEqChange).not.toHaveBeenCalled();
  });

  it("bypass, reset and remove commit the expected eq", async () => {
    const { handlers, deps } = setup();
    await handlers.toggleBypass("a");
    expect(deps.commitTrackEqChange.mock.calls[0][0].eq?.enabled).toBe(false);
    await handlers.reset("a");
    expect(deps.commitTrackEqChange.mock.calls[1][0].eq).toEqual(defaultTrackEq());
    await handlers.remove("a");
    expect(deps.commitTrackEqChange.mock.calls[2][0].eq).toBeNull();
  });

  it("the analyzer starts on a track, stops with null and reads the bands", async () => {
    const { handlers, deps } = setup();
    handlers.startAnalyzer("a");
    handlers.stopAnalyzer();
    expect(deps.setTrackEqAnalyzer.mock.calls).toEqual([["a"], [null]]);
    expect(await handlers.readSpectrum()).toEqual([-20, -30]);
    deps.getTrackEqSpectrum.mockRejectedValueOnce(new Error("no engine"));
    expect(await handlers.readSpectrum()).toEqual([]);
  });
});
