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
  const tracks = [
    track("parent-1"),
    track("target", "parent-1"),
    track("dragged"),
    track("other"),
  ];
  const tracksById: Record<string, TrackSummary> = Object.fromEntries(
    tracks.map((entry) => [entry.id, entry]),
  );

  const songState: { current: SongView | null } = {
    current: { tracks } as unknown as SongView,
  };
  const deps: TrackHandlerDeps = {
    getSong: () => songState.current,
    setSong: vi.fn((next) => {
      songState.current = typeof next === "function" ? next(songState.current) : next;
    }),
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
    setAutomationTrackPosition: vi.fn(async () => snapshot(5)),
    getVisibleTrackIds: () => Object.keys(tracksById),
    ...overrides,
  };
  return { handlers: createTrackHandlers(deps), deps, tracksById, songState };
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

  it("a multi-selection dropped 'after' keeps its on-screen order", async () => {
    // Each move lands right after the target, so moving them in order would
    // reverse them; the plan moves them back to front instead.
    const { handlers, deps } = setup({
      getSelectedTrackIds: () => ["other", "dragged"],
    });
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "after",
    });
    const moved = vi
      .mocked(deps.moveTrack)
      .mock.calls.map(([args]) => args.trackId);
    expect(moved).toEqual(["other", "dragged"]);
  });

  // With 138 tracks the drop took seconds: it refetched every waveform and
  // then the revision effect fetched the song again.
  it("reordering skips the waveform payload and records the revision", async () => {
    const { handlers, deps } = setup();
    await handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "before",
    });
    expect(deps.refreshSongView).toHaveBeenCalledWith({
      includeWaveforms: false,
    });
    expect(deps.optimisticallyAppliedRevisionsRef.current.has(3)).toBe(true);
  });

  // The release used to wait for every moveTrack and the refresh before the
  // floating copy went away: the drop looked frozen.
  it("accepts the drop preview before waiting on the backend", async () => {
    let resolveMove: (value: TransportSnapshot) => void = () => {};
    const { handlers, deps } = setup({
      moveTrack: vi.fn(
        () => new Promise<TransportSnapshot>((resolve) => (resolveMove = resolve)),
      ),
    });
    const drop = handlers.handleTrackDrop("dragged", {
      targetTrackId: "target",
      mode: "before",
    });

    expect(deps.clearTrackDragVisuals).toHaveBeenCalledWith({ settle: true });
    resolveMove(snapshot(3));
    await drop;
    expect(deps.clearTrackDragVisuals).toHaveBeenCalledTimes(1);
  });

  // The headers moved at once but the clips waited for the backend: the
  // canvas paints from song.tracks. The drop now applies the order locally.
  it("paints the new track order before the backend answers", async () => {
    let resolveMove: (value: TransportSnapshot) => void = () => {};
    const { handlers, songState } = setup({
      moveTrack: vi.fn(
        () => new Promise<TransportSnapshot>((resolve) => (resolveMove = resolve)),
      ),
    });
    const drop = handlers.handleTrackDrop("dragged", {
      targetTrackId: "parent-1",
      mode: "before",
    });

    expect(songState.current!.tracks.map((entry) => entry.id)).toEqual([
      "dragged",
      "parent-1",
      "target",
      "other",
    ]);
    resolveMove(snapshot(3));
    await drop;
  });

  it("puts the rows back when the backend refuses the move", async () => {
    const { handlers, deps, songState } = setup({
      moveTrack: vi.fn(async () => {
        throw new Error("nope");
      }),
      runAction: vi.fn(async (action) => {
        await action().catch(() => {});
      }),
    });
    await handlers.handleTrackDrop("dragged", { targetTrackId: "target", mode: "before" });

    expect(deps.clearTrackDragVisuals).toHaveBeenLastCalledWith({ revert: true });
    expect(songState.current!.tracks.map((entry) => entry.id)).toEqual([
      "parent-1",
      "target",
      "dragged",
      "other",
    ]);
  });

  // Settling after the refresh left the rows offset over the new order: the
  // preview is dropped when the new order renders, which had already happened.
  it("moving the automation lane settles the preview before the refresh", async () => {
    const calls: string[] = [];
    const { handlers, deps } = setup({
      getVisibleTrackIds: () => ["__automation__", "parent-1", "target", "dragged", "other"],
      clearTrackDragVisuals: vi.fn((options) => {
        calls.push(`clear:${JSON.stringify(options ?? {})}`);
      }),
      refreshSongView: vi.fn(async () => {
        calls.push("refresh");
        return null;
      }),
    });
    await handlers.handleTrackDrop("__automation__", {
      targetTrackId: "dragged",
      mode: "after",
    });

    expect(deps.setAutomationTrackPosition).toHaveBeenCalledWith("dragged");
    expect(calls).toEqual(['clear:{"settle":true}', "refresh"]);
  });

  it("create track is cancelled when the name prompt is empty", async () => {
    const { handlers, deps } = setup({ prompt: vi.fn(async () =>"   ") });
    await handlers.handleCreateTrack("audio", null);
    expect(deps.createTrack).not.toHaveBeenCalled();
  });

  // A new MIDI track used to offer the audio track's default name.
  it("each kind of track proposes its own default name", async () => {
    const { handlers, deps } = setup();
    await handlers.handleCreateTrack("midi", null);
    await handlers.handleCreateTrack("audio", null);
    expect(deps.prompt).toHaveBeenNthCalledWith(1, "transport.prompt.trackName", "transport.midi.trackDefaultName");
    expect(deps.prompt).toHaveBeenNthCalledWith(2, "transport.prompt.trackName", "transport.defaults.audioTrackName");
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
