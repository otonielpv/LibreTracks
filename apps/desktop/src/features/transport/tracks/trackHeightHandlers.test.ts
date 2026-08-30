import { describe, expect, it, vi } from "vitest";

import type {
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createTrackHeightHandlers,
  type TrackHeightHandlerDeps,
} from "./trackHeightHandlers";
import { buildTrackRowLayout } from "./trackLayout";

const BASE_HEIGHT = 40;

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const track = (id: string, heightOffset: number | null = null): TrackSummary =>
  ({ id, name: id, heightOffset }) as unknown as TrackSummary;

/**
 * Three rows: 40 / 160 / 40 — so the bands are [0,40) [40,200) [200,240) and a
 * test can tell "the row the pointer is on" apart from "y / trackHeight".
 */
function setup(overrides: Partial<TrackHeightHandlerDeps> = {}) {
  const tracks = [track("a"), track("b", 120), track("c")];
  const song = { projectRevision: 1, tracks } as unknown as SongView;
  const songRef = { current: song };
  const selectedTrackIds: string[] = [];
  // Persisting sends a second patch (the revision), so the assertions replay
  // every patch in order rather than just the last one.
  const songPatches: Array<(p: SongView | null) => SongView | null> = [];

  const deps: TrackHeightHandlerDeps = {
    getBaseHeight: () => BASE_HEIGHT,
    getRowLayout: () => buildTrackRowLayout(tracks, BASE_HEIGHT),
    getVisibleTrackIds: () => tracks.map((entry) => entry.id),
    getSelectedTrackIds: () => selectedTrackIds,
    getSong: () => songRef.current,
    setSong: vi.fn((update) => {
      songPatches.push(update);
    }),
    setBaseHeight: vi.fn(),
    updateTrackHeightOffset: vi.fn(async () => snapshot(7)),
    runAction: vi.fn(async (action) => {
      await action();
    }),
    applyPlaybackSnapshot: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
    ...overrides,
  };

  return {
    handlers: createTrackHeightHandlers(deps),
    deps,
    selectedTrackIds,
    song,
    applyPatch: () =>
      songPatches.reduce<SongView | null>(
        (current, patch) => patch(current),
        song,
      ) as SongView,
  };
}

describe("stepRowHeightAtY", () => {
  it("resizes the row the pointer is over, not the row a division would pick", () => {
    // y = 150 is inside the tall middle row; 150 / 40 would say row 3.
    const { handlers, deps, applyPatch } = setup();

    handlers.stepRowHeightAtY(150, 8);

    const next = applyPatch();
    expect(next.tracks.map((entry) => entry.heightOffset)).toEqual([
      null,
      128,
      null,
    ]);
    expect(deps.setBaseHeight).not.toHaveBeenCalled();
  });

  it("shrinks the row on a negative step", () => {
    const { handlers, applyPatch } = setup();

    handlers.stepRowHeightAtY(10, -8);

    expect(applyPatch().tracks[0].heightOffset).toBe(-8);
  });

  it("ignores a pointer past the last row", () => {
    const { handlers, deps } = setup();

    handlers.stepRowHeightAtY(500, 8);

    expect(deps.setSong).not.toHaveBeenCalled();
    expect(deps.updateTrackHeightOffset).not.toHaveBeenCalled();
  });

  it("ignores a row that is not a real track (the automation lane)", () => {
    const { handlers, deps } = setup({
      // A synthetic lane sits first in the visible rows but is not in the song.
      getVisibleTrackIds: () => ["__automation__", "a", "b"],
    });

    handlers.stepRowHeightAtY(0, 8);

    expect(deps.setSong).not.toHaveBeenCalled();
  });

  it("resizes the whole selection when the row is part of it", () => {
    const { handlers, selectedTrackIds, applyPatch } = setup();
    selectedTrackIds.push("a", "c");

    handlers.stepRowHeightAtY(10, 8);

    expect(applyPatch().tracks.map((entry) => entry.heightOffset)).toEqual([
      8,
      120,
      8,
    ]);
  });
});

describe("resetRowHeight", () => {
  it("drops the offset and persists it as null", async () => {
    const { handlers, deps, applyPatch } = setup();

    handlers.resetRowHeight("b");
    await Promise.resolve();

    const next = applyPatch();
    expect(next.tracks[1].heightOffset).toBeNull();
    expect(next.projectRevision).toBe(7);
    expect(deps.updateTrackHeightOffset).toHaveBeenCalledWith({
      trackId: "b",
      heightOffset: null,
    });
  });

  it("records the revision it just wrote so the song is not refetched", async () => {
    const { handlers, deps } = setup();

    handlers.resetRowHeight("b");
    await Promise.resolve();

    expect(
      deps.optimisticallyAppliedRevisionsRef.current.has(7),
    ).toBe(true);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalled();
  });
});

describe("stepRowHeight", () => {
  it("clamps a row instead of letting it vanish", () => {
    const { handlers, applyPatch } = setup();

    handlers.stepRowHeight("a", -400);

    // TRACK_HEIGHT_MIN is 18, so from a 40px row the offset floors at -22.
    expect(applyPatch().tracks[0].heightOffset).toBe(-22);
  });

  it("lets a single row grow past the global maximum", () => {
    const { handlers, applyPatch } = setup();

    handlers.stepRowHeight("a", 260);

    expect(applyPatch().tracks[0].heightOffset).toBe(260);
  });
});
