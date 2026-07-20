import { describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createTrackHeaderHandlers,
  type TrackHeaderHandlerDeps,
} from "./trackHeaderHandlers";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const track = (id: string, overrides: Partial<TrackSummary> = {}) =>
  ({
    id,
    name: id,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    transposeEnabled: false,
    ...overrides,
  }) as unknown as TrackSummary;

const mouseEvent = (
  overrides: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    button: number;
  }> = {},
) =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    button: 0,
    stopPropagation: vi.fn(),
    ...overrides,
  }) as unknown as ReactMouseEvent<HTMLDivElement>;

function setup(overrides: Partial<TrackHeaderHandlerDeps> = {}) {
  const tracks: Record<string, TrackSummary> = {
    t1: track("t1"),
    t2: track("t2"),
    t3: track("t3"),
  };
  const suppressTrackClickRef = { current: false };
  const trackSelectionAnchorRef = { current: null as string | null };
  const trackDragRef = { current: null as TrackHeaderHandlerDeps["trackDragRef"]["current"] };
  const optimisticallyAppliedRevisionsRef = { current: new Set<number>() };
  let selected: string[] = [];
  let songPatch: ((p: SongView | null) => SongView | null) | undefined;
  let collapsedPatch: ((c: Set<string>) => Set<string>) | undefined;

  const deps: TrackHeaderHandlerDeps = {
    findTrack: (trackId) => tracks[trackId] ?? null,
    getVisibleTrackIds: () => ["t1", "t2", "t3"],
    getSelectedTrackIds: () => selected,
    selectTrack: vi.fn((ids: string[]) => {
      selected = ids;
    }),
    resolveTrackMix: (t) => ({
      muted: t.muted,
      solo: t.solo,
      volume: t.volume,
      pan: t.pan,
    }),
    patchTrackOptimisticMix: vi.fn(),
    queueTrackMixLiveUpdate: vi.fn(),
    persistTrackMix: vi.fn(async () => {}),
    runAction: vi.fn(async (action) => {
      await action();
    }),
    applyPlaybackSnapshot: vi.fn(),
    optimisticallyAppliedRevisionsRef,
    setSong: vi.fn((update) => {
      songPatch = update;
    }),
    setCollapsedFolders: vi.fn((update) => {
      collapsedPatch = update;
    }),
    setContextMenu: vi.fn(),
    setPitchPrepareUiState: vi.fn(),
    setStatus: vi.fn(),
    t: (key, options) => `${key}:${JSON.stringify(options ?? {})}`,
    updateTrackTransposeEnabled: vi.fn(async () => snapshot(11)),
    suppressTrackClickRef,
    trackSelectionAnchorRef,
    trackDragRef,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    getElementScaleX: () => 1,
    getElementScaleY: () => 1,
    maxTrackGain: 3.162,
    ...overrides,
  };

  return {
    handlers: createTrackHeaderHandlers(deps),
    deps,
    tracks,
    suppressTrackClickRef,
    trackSelectionAnchorRef,
    trackDragRef,
    optimisticallyAppliedRevisionsRef,
    getSelected: () => selected,
    getSongPatch: () => songPatch,
    getCollapsedPatch: () => collapsedPatch,
  };
}

describe("createTrackHeaderHandlers", () => {
  describe("selection", () => {
    it("plain click selects a single track and seeds the anchor", () => {
      const { handlers, getSelected, trackSelectionAnchorRef } = setup();
      handlers.handleTrackHeaderSelect("t2", "Track 2", mouseEvent());

      expect(getSelected()).toEqual(["t2"]);
      expect(trackSelectionAnchorRef.current).toBe("t2");
    });

    it("ctrl-click toggles a track in and out of the selection", () => {
      const { handlers, getSelected } = setup();
      handlers.handleTrackHeaderSelect("t1", "Track 1", mouseEvent());
      handlers.handleTrackHeaderSelect(
        "t3",
        "Track 3",
        mouseEvent({ ctrlKey: true }),
      );
      expect(getSelected()).toEqual(["t1", "t3"]);

      handlers.handleTrackHeaderSelect(
        "t3",
        "Track 3",
        mouseEvent({ ctrlKey: true }),
      );
      expect(getSelected()).toEqual(["t1"]);
    });

    it("shift-click extends from the anchor across the visible range", () => {
      const { handlers, getSelected, trackSelectionAnchorRef } = setup();
      handlers.handleTrackHeaderSelect("t1", "Track 1", mouseEvent());
      handlers.handleTrackHeaderSelect(
        "t3",
        "Track 3",
        mouseEvent({ shiftKey: true }),
      );

      expect(getSelected()).toEqual(["t1", "t2", "t3"]);
      // Anchor stays put so a second shift-click re-extends from t1.
      expect(trackSelectionAnchorRef.current).toBe("t1");
    });

    it("shift-click with no usable anchor falls back to single-select", () => {
      const { handlers, getSelected, trackSelectionAnchorRef } = setup();
      handlers.handleTrackHeaderSelect(
        "t2",
        "Track 2",
        mouseEvent({ shiftKey: true }),
      );

      expect(getSelected()).toEqual(["t2"]);
      expect(trackSelectionAnchorRef.current).toBe("t2");
    });

    it("swallows the click that follows a drag release", () => {
      const { handlers, deps, suppressTrackClickRef } = setup();
      suppressTrackClickRef.current = true;

      handlers.handleTrackHeaderSelect("t1", "Track 1", mouseEvent());

      expect(deps.selectTrack).not.toHaveBeenCalled();
      // The flag is consumed, so the next click selects normally.
      expect(suppressTrackClickRef.current).toBe(false);
    });
  });

  describe("drag start", () => {
    const dragEvent = (closestImpl: (selector: string) => unknown) =>
      ({
        button: 0,
        clientX: 100,
        clientY: 200,
        stopPropagation: vi.fn(),
        currentTarget: {
          closest: closestImpl,
          getBoundingClientRect: () => ({ width: 10, height: 10 }) as DOMRect,
          offsetWidth: 10,
          offsetHeight: 10,
        },
      }) as unknown as ReactMouseEvent<HTMLElement>;

    it("ignores non-primary buttons", () => {
      const { handlers, trackDragRef } = setup();
      handlers.handleTrackHeaderDragStart(
        dragEvent(() => null) as ReactMouseEvent<HTMLElement>,
        "t1",
      );
      expect(trackDragRef.current).not.toBeNull();

      trackDragRef.current = null;
      const secondary = {
        ...dragEvent(() => null),
        button: 2,
      } as unknown as ReactMouseEvent<HTMLElement>;
      handlers.handleTrackHeaderDragStart(secondary, "t1");
      expect(trackDragRef.current).toBeNull();
    });

    it("routes a compact-strip drag through the horizontal pipeline", () => {
      const strip = {
        getBoundingClientRect: () => ({ width: 10, height: 10 }) as DOMRect,
        offsetWidth: 10,
        offsetHeight: 10,
      };
      const { handlers, trackDragRef } = setup();
      handlers.handleTrackHeaderDragStart(
        dragEvent((selector) =>
          selector === ".lt-compact-mixer-strip" ? strip : null,
        ),
        "t1",
      );

      expect(trackDragRef.current?.originSurface).toBe("compact");
      expect(trackDragRef.current?.rowElement).toBe(strip);
    });

    it("routes a DAW header drag through the vertical pipeline", () => {
      const header = {
        id: "header",
        getBoundingClientRect: () => ({ width: 10, height: 10 }) as DOMRect,
        offsetWidth: 10,
        offsetHeight: 10,
      };
      const row = { id: "row" };
      const { handlers, trackDragRef } = setup();
      handlers.handleTrackHeaderDragStart(
        dragEvent((selector) => {
          if (selector === ".lt-track-header") return header;
          if (selector === ".lt-track-header-row") return row;
          return null;
        }),
        "t1",
      );

      expect(trackDragRef.current?.originSurface).toBe("daw");
      expect(trackDragRef.current?.headerElement).toBe(header);
      expect(trackDragRef.current?.rowElement).toBe(row);
    });
  });

  describe("mix controls", () => {
    it("mute toggle inverts the resolved mix and persists", async () => {
      const { handlers, deps } = setup();
      handlers.handleTrackHeaderMuteToggle("t1");

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        muted: true,
      });
      expect(deps.queueTrackMixLiveUpdate).toHaveBeenCalledWith("t1", [
        "muted",
      ]);
      expect(deps.persistTrackMix).toHaveBeenCalledWith("t1", ["muted"]);
    });

    it("solo toggle inverts the resolved mix and persists", async () => {
      const { handlers, deps } = setup({
        findTrack: () => track("t1", { solo: true }),
      });
      handlers.handleTrackHeaderSoloToggle("t1");

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        solo: false,
      });
    });

    it("mute/solo on a missing track is a no-op", () => {
      const { handlers, deps } = setup({ findTrack: () => null });
      handlers.handleTrackHeaderMuteToggle("gone");
      handlers.handleTrackHeaderSoloToggle("gone");

      expect(deps.patchTrackOptimisticMix).not.toHaveBeenCalled();
      expect(deps.persistTrackMix).not.toHaveBeenCalled();
    });

    it("volume change clamps to the fader headroom, not unity", () => {
      const { handlers, deps } = setup();
      handlers.handleTrackHeaderVolumeChange("t1", 99);

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        volume: 3.162,
      });
    });

    it("pan change clamps to [-1, 1]", () => {
      const { handlers, deps } = setup();
      handlers.handleTrackHeaderPanChange("t1", -5);

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        pan: -1,
      });
    });

    it("volume and pan commits persist only their own key", async () => {
      const { handlers, deps } = setup();
      handlers.handleTrackHeaderVolumeCommit("t1");
      handlers.handleTrackHeaderPanCommit("t1");

      expect(deps.persistTrackMix).toHaveBeenCalledWith("t1", ["volume"]);
      expect(deps.persistTrackMix).toHaveBeenCalledWith("t1", ["pan"]);
    });

    it("streams live updates during a drag without persisting", () => {
      const { handlers, deps } = setup();
      handlers.handleTrackHeaderVolumeChange("t1", 0.5);

      expect(deps.queueTrackMixLiveUpdate).toHaveBeenCalledWith("t1", [
        "volume",
      ]);
      expect(deps.persistTrackMix).not.toHaveBeenCalled();
    });
  });

  describe("folder collapse", () => {
    it("toggles a folder id in and out of the collapsed set", () => {
      const { handlers, getCollapsedPatch } = setup();

      handlers.handleTrackHeaderFolderToggle("f1");
      expect(getCollapsedPatch()?.(new Set())).toEqual(new Set(["f1"]));

      handlers.handleTrackHeaderFolderToggle("f1");
      expect(getCollapsedPatch()?.(new Set(["f1"]))).toEqual(new Set());
    });
  });

  describe("transpose toggle", () => {
    it("optimistically patches the song and records the revision", async () => {
      const { handlers, deps, optimisticallyAppliedRevisionsRef, getSongPatch } =
        setup();
      await handlers.handleTrackHeaderTransposeToggle("t1");

      expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledWith({
        trackId: "t1",
        transposeEnabled: true,
      });
      expect(optimisticallyAppliedRevisionsRef.current.has(11)).toBe(true);
      expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(11));

      const patched = getSongPatch()?.({
        tracks: [track("t1"), track("t2")],
      } as unknown as SongView);
      expect(patched?.tracks[0].transposeEnabled).toBe(true);
      expect(patched?.tracks[1].transposeEnabled).toBe(false);
      expect(patched?.projectRevision).toBe(11);
    });

    it("raises the pitch-prepare overlay before the IPC round-trip", async () => {
      const { handlers, deps } = setup();
      await handlers.handleTrackHeaderTransposeToggle("t1");

      expect(deps.setPitchPrepareUiState).toHaveBeenCalledWith(
        expect.objectContaining({ active: true }),
      );
    });

    it("is a no-op for a missing track", async () => {
      const { handlers, deps } = setup({ findTrack: () => null });
      await handlers.handleTrackHeaderTransposeToggle("gone");

      expect(deps.updateTrackTransposeEnabled).not.toHaveBeenCalled();
    });
  });
});
