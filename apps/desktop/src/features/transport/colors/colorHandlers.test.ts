import { describe, expect, it, vi } from "vitest";

import type {
  ClipSummary,
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createColorHandlers,
  type ColorHandlerDeps,
} from "./colorHandlers";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const track = (id: string): TrackSummary =>
  ({ id, name: id, color: null }) as unknown as TrackSummary;

const clip = (id: string): ClipSummary =>
  ({ id, color: null }) as unknown as ClipSummary;

function setup(overrides: Partial<ColorHandlerDeps> = {}) {
  const optimisticallyAppliedRevisionsRef = { current: new Set<number>() };
  let songPatch: ((p: SongView | null) => SongView | null) | undefined;

  const deps: ColorHandlerDeps = {
    runAction: vi.fn(async (action) => {
      await action();
    }),
    setSong: vi.fn((update) => {
      songPatch = update;
    }),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    optimisticallyAppliedRevisionsRef,
    clipDisplayName: (c) => c.id,
    updateTrackColor: vi.fn(async () => snapshot(7)),
    updateClipColor: vi.fn(async () => snapshot(9)),
    ...overrides,
  };

  return {
    handlers: createColorHandlers(deps),
    deps,
    optimisticallyAppliedRevisionsRef,
    getSongPatch: () => songPatch,
  };
}

describe("createColorHandlers", () => {
  it("track colour optimistically patches the song and records the revision", async () => {
    const { handlers, deps, optimisticallyAppliedRevisionsRef, getSongPatch } =
      setup();
    await handlers.handleSetTrackColor(track("t1"), "#fff");

    expect(deps.updateTrackColor).toHaveBeenCalledWith({
      trackId: "t1",
      color: "#fff",
    });
    expect(optimisticallyAppliedRevisionsRef.current.has(7)).toBe(true);

    const prev = {
      projectRevision: 1,
      tracks: [track("t1"), track("t2")],
      clips: [],
    } as unknown as SongView;
    const next = getSongPatch()!(prev) as SongView;
    expect(next.projectRevision).toBe(7);
    expect(next.tracks.find((t) => t.id === "t1")?.color).toBe("#fff");
    expect(next.tracks.find((t) => t.id === "t2")?.color).toBeNull();
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalled();
  });

  it("handleSetTrackColors delegates to the single-track path for one track", async () => {
    const updateTrackColor = vi.fn(async () => snapshot(7));
    const { handlers } = setup({ updateTrackColor });
    await handlers.handleSetTrackColors([track("only")], "#abc");
    expect(updateTrackColor).toHaveBeenCalledTimes(1);
    expect(updateTrackColor).toHaveBeenCalledWith({
      trackId: "only",
      color: "#abc",
    });
  });

  it("handleSetTrackColors is a no-op for an empty selection", async () => {
    const { handlers, deps } = setup();
    await handlers.handleSetTrackColors([], "#abc");
    expect(deps.updateTrackColor).not.toHaveBeenCalled();
    expect(deps.runAction).not.toHaveBeenCalled();
  });

  it("clip colour patches only the matching clip", async () => {
    const { handlers, getSongPatch } = setup();
    await handlers.handleSetClipColor(clip("c1"), "#0f0");
    const prev = {
      projectRevision: 1,
      tracks: [],
      clips: [clip("c1"), clip("c2")],
    } as unknown as SongView;
    const next = getSongPatch()!(prev) as SongView;
    expect(next.clips.find((c) => c.id === "c1")?.color).toBe("#0f0");
    expect(next.clips.find((c) => c.id === "c2")?.color).toBeNull();
  });
});
