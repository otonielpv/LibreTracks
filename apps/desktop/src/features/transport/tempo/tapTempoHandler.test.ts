import { describe, expect, it, vi } from "vitest";

import type {
  SongView,
  TempoMarkerSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createTapTempoHandler,
  type TapTempoHandlerDeps,
} from "./tapTempoHandler";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

// A 120 BPM tap is one tap every 500ms. The handler reads now() each call, so a
// controllable clock lets us simulate a steady tap.
function clock(startMs: number, stepMs: number) {
  let value = startMs;
  return () => {
    const current = value;
    value += stepMs;
    return current;
  };
}

function setup(overrides: Partial<TapTempoHandlerDeps> = {}) {
  const tapTempoTimesRef = { current: [] as number[] };
  // Minimal song shape getEffectiveBpmAt can read: a base bpm + no markers so
  // the effective BPM resolves to the base (60, well away from 120).
  const song = {
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [],
    baseBpm: 60,
  } as unknown as SongView;
  const deps: TapTempoHandlerDeps = {
    getSong: () => song,
    getCursorSeconds: () => 0,
    tapTempoTimesRef,
    tempoDraftDirtyRef: { current: true },
    setTempoDraft: vi.fn(),
    setStatus: vi.fn(),
    runAction: vi.fn(async (action) => {
      await action();
    }),
    refreshSongView: vi.fn(async () => null),
    applyPlaybackSnapshot: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
    getEffectiveTempoMarkerAt: () => null,
    upsertSongTempoMarker: vi.fn(async () => snapshot(2)),
    updateSongTempo: vi.fn(async () => snapshot(2)),
    t: (key) => key,
    now: clock(1000, 500),
    ...overrides,
  };
  return { handleTapTempo: createTapTempoHandler(deps), deps, tapTempoTimesRef };
}

describe("createTapTempoHandler", () => {
  it("clears taps and bails when there is no song", () => {
    const { handleTapTempo, deps, tapTempoTimesRef } = setup({
      getSong: () => null,
    });
    tapTempoTimesRef.current = [1, 2, 3];
    handleTapTempo();
    expect(tapTempoTimesRef.current).toEqual([]);
    expect(deps.setStatus).not.toHaveBeenCalled();
  });

  it("shows the waiting status on the first tap", () => {
    const { handleTapTempo, deps } = setup();
    handleTapTempo();
    expect(deps.setStatus).toHaveBeenCalledWith(
      "transport.status.tapTempoWaiting",
    );
    expect(deps.setTempoDraft).not.toHaveBeenCalled();
  });

  it("derives 240 BPM from steady 250ms taps and persists via updateSongTempo", async () => {
    const updateSongTempo = vi.fn(async () => snapshot(2));
    const { handleTapTempo, deps } = setup({
      updateSongTempo,
      now: clock(1000, 250), // 250ms cadence -> 240 BPM, far from any base
    });
    handleTapTempo();
    handleTapTempo();
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setTempoDraft).toHaveBeenLastCalledWith("240.0");
    expect(updateSongTempo).toHaveBeenCalledWith(240);
  });

  it("upserts onto the active tempo marker when one exists at the cursor", async () => {
    const marker = {
      startSeconds: 4,
      sourceStartSeconds: 4,
    } as unknown as TempoMarkerSummary;
    const upsertSongTempoMarker = vi.fn(async () => snapshot(2));
    const { handleTapTempo } = setup({
      getEffectiveTempoMarkerAt: () => marker,
      upsertSongTempoMarker,
      now: clock(1000, 250),
    });
    handleTapTempo();
    handleTapTempo();
    await Promise.resolve();
    await Promise.resolve();
    expect(upsertSongTempoMarker).toHaveBeenCalledWith(4, 240);
  });
});
