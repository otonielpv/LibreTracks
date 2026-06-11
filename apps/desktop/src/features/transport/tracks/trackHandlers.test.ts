import { describe, expect, it, vi } from "vitest";

import type {
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createTrackHandlers,
  type TrackHandlerDeps,
} from "./trackHandlers";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const track = (id: string, parentTrackId: string | null = null): TrackSummary =>
  ({ id, name: id, parentTrackId }) as unknown as TrackSummary;

function setup(overrides: Partial<TrackHandlerDeps> = {}) {
  const tracksById: Record<string, TrackSummary> = {
    target: track("target", "parent-1"),
    dragged: track("dragged"),
  };

  const deps: TrackHandlerDeps = {
    getSong: () => ({}) as SongView,
    getTracksById: () => tracksById,
    getSelectedTrackIds: () => [],
    runAction: vi.fn(async (action) => {
      await action();
    }),
    refreshSongView: vi.fn(async () => null),
    applyPlaybackSnapshot: vi.fn(),
    clearTrackDragVisuals: vi.fn(),
    optimisticallyAppliedRevisionsRef: { current: new Set<number>() },
    setStatus: vi.fn(),
    t: (key) => key,
    moveTrack: vi.fn(async () => snapshot(3)),
    createTrack: vi.fn(async () => snapshot(4)),
    prompt: vi.fn(async () =>"My Track"),
    ...overrides,
  };
  return { handlers: createTrackHandlers(deps), deps, tracksById };
}

describe("createTrackHandlers", () => {
  it("drop onto self / missing target just clears the drag visuals", async () => {
    const { handlers, deps } = setup();
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "missing",
      mode: "after",
    });
    expect(deps.clearTrackDragVisuals).toHaveBeenCalled();
    expect(deps.moveTrack).not.toHaveBeenCalled();
  });

  it("'inside-folder' reparents the dragged track under the target", async () => {
    const { handlers, deps } = setup();
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "inside-folder",
    });
    expect(deps.moveTrack).toHaveBeenCalledWith({
      trackId: "dragged",
      insertAfterTrackId: null,
      insertBeforeTrackId: null,
      parentTrackId: "target",
    });
  });

  it("'before' inserts before the target, inheriting its parent", async () => {
    const { handlers, deps } = setup();
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "before",
    });
    expect(deps.moveTrack).toHaveBeenCalledWith({
      trackId: "dragged",
      insertAfterTrackId: null,
      insertBeforeTrackId: "target",
      parentTrackId: "parent-1",
    });
  });

  it("moves the whole multi-selection when the dragged track is part of it", async () => {
    const { handlers, deps } = setup({
      getSelectedTrackIds: () => ["dragged", "other"],
    });
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "after",
    });
    expect(deps.moveTrack).toHaveBeenCalledTimes(2);
  });

  it("create track is cancelled when the name prompt is empty", async () => {
    const { handlers, deps } = setup({ prompt: vi.fn(async () =>"   ") });
    await handlers.handleCreateTrack("audio", null);
    expect(deps.createTrack).not.toHaveBeenCalled();
  });

  it("create track skips the waveform payload and records the revision", async () => {
    const { handlers, deps } = setup();
    await handlers.handleCreateTrack("folder", track("anchor"));
    expect(deps.createTrack).toHaveBeenCalledWith({
      name: "My Track",
      kind: "folder",
      insertAfterTrackId: "anchor",
      parentTrackId: null,
    });
    expect(deps.refreshSongView).toHaveBeenCalledWith({
      includeWaveforms: false,
    });
    expect(deps.optimisticallyAppliedRevisionsRef.current.has(4)).toBe(true);
  });
});
