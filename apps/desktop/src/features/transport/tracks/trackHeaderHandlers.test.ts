import { describe, expect, it, vi } from "vitest";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import type {
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createTrackHeaderHandlers,
  type TrackHeaderHandlerDeps,
} from "./trackHeaderHandlers";
import { useTimelineUIStore } from "../uiStore";

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
  // Mirrors React: the updater is applied against live state, which the folder
  // toggle relies on to know which way it just folded.
  let collapsedFolders = new Set<string>();

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
    commitTrackMixChange: vi.fn(async () => snapshot(17)),
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
      collapsedFolders = update(collapsedFolders);
    }),
    setContextMenu: vi.fn(),
    setPitchPrepareUiState: vi.fn(),
    setStatus: vi.fn(),
    t: (key, options) => `${key}:${JSON.stringify(options ?? {})}`,
    updateTrackTransposeEnabled: vi.fn(async () => snapshot(11)),
    updateTrackCollapsed: vi.fn(async () => snapshot(13)),
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
    getCollapsedFolders: () => collapsedFolders,
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
        preventDefault: vi.fn(),
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

    it("requires reorder mode for touch, while mouse remains immediate", () => {
      const { handlers, trackDragRef } = setup();
      const touch = {
        ...dragEvent(() => null),
        pointerType: "touch",
        pointerId: 7,
      } as unknown as ReactPointerEvent<HTMLElement>;

      useTimelineUIStore.getState().setTrackReorderMode(false);
      handlers.handleTrackHeaderDragStart(touch, "t1");
      expect(trackDragRef.current).toBeNull();

      useTimelineUIStore.getState().setTrackReorderMode(true);
      handlers.handleTrackHeaderDragStart(touch, "t1");
      expect(trackDragRef.current?.pointerId).toBe(7);
      expect(touch.preventDefault).toHaveBeenCalledOnce();
      useTimelineUIStore.getState().setTrackReorderMode(false);
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

  describe("multi-track edits", () => {
    /** Selects t1..t3 up front so every control edits the whole group. */
    const multiSetup = (overrides: Partial<TrackHeaderHandlerDeps> = {}) => {
      let selected = ["t1", "t2", "t3"];
      return setup({
        getSelectedTrackIds: () => selected,
        selectTrack: vi.fn((ids: string[]) => {
          selected = ids;
        }),
        ...overrides,
      });
    };

    it("mute sets the whole selection to the clicked track's new state", async () => {
      const { handlers, deps } = multiSetup({
        // t2 is already muted; it must stay muted rather than toggle off.
        findTrack: (id) =>
          id === "t2" ? track("t2", { muted: true }) : track(id),
      });
      handlers.handleTrackHeaderMuteToggle("t1");

      for (const id of ["t1", "t2", "t3"]) {
        expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith(id, {
          muted: true,
        });
        expect(deps.persistTrackMix).toHaveBeenCalledWith(id, ["muted"]);
      }
    });

    it("solo sets the whole selection to the clicked track's new state", () => {
      const { handlers, deps } = multiSetup();
      handlers.handleTrackHeaderSoloToggle("t1");

      for (const id of ["t1", "t2", "t3"]) {
        expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith(id, {
          solo: true,
        });
      }
    });

    it("volume moves the group by the dragged track's dB delta", () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) =>
          id === "t2" ? track("t2", { volume: 0.5 }) : track(id, { volume: 1 }),
      });
      // t1: 1.0 -> 0.5 is -6.02 dB, so t2 (0.5) halves to 0.25.
      handlers.handleTrackHeaderVolumeChange("t1", 0.5);

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        volume: 0.5,
      });
      const t2Call = vi
        .mocked(deps.patchTrackOptimisticMix)
        .mock.calls.find(([id]) => id === "t2");
      expect(t2Call?.[1].volume).toBeCloseTo(0.25, 4);
    });

    it("volume from silence only moves the dragged track", () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) => track(id, { volume: id === "t1" ? 0 : 1 }),
      });
      handlers.handleTrackHeaderVolumeChange("t1", 0.5);

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledTimes(1);
      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t1", {
        volume: 0.5,
      });
    });

    it("pan moves the group by the dragged track's offset", () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) =>
          track(id, { pan: id === "t2" ? -0.5 : 0 }),
      });
      // t1: 0 -> 0.25 is +0.25, so t2 goes -0.5 -> -0.25.
      handlers.handleTrackHeaderPanChange("t1", 0.25);

      const t2Call = vi
        .mocked(deps.patchTrackOptimisticMix)
        .mock.calls.find(([id]) => id === "t2");
      expect(t2Call?.[1].pan).toBeCloseTo(-0.25, 4);
    });

    it("pan clamps each track to its own range without dragging the rest", () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) => track(id, { pan: id === "t2" ? 0.9 : 0 }),
      });
      handlers.handleTrackHeaderPanChange("t1", 0.5);

      const t2Call = vi
        .mocked(deps.patchTrackOptimisticMix)
        .mock.calls.find(([id]) => id === "t2");
      expect(t2Call?.[1].pan).toBe(1);
    });

    it("commits persist every selected track", async () => {
      const { handlers, deps } = multiSetup();
      handlers.handleTrackHeaderVolumeCommit("t1");
      handlers.handleTrackHeaderPanCommit("t1");

      for (const id of ["t1", "t2", "t3"]) {
        expect(deps.persistTrackMix).toHaveBeenCalledWith(id, ["volume"]);
        expect(deps.persistTrackMix).toHaveBeenCalledWith(id, ["pan"]);
      }
    });

    it("transpose toggles every selected track that isn't already there", async () => {
      const { handlers, deps, getSongPatch } = multiSetup({
        // t3 is already enabled, so it needs no round-trip.
        findTrack: (id) =>
          track(id, { transposeEnabled: id === "t3" }),
      });
      await handlers.handleTrackHeaderTransposeToggle("t1");

      expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledTimes(2);
      expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledWith({
        trackId: "t1",
        transposeEnabled: true,
      });
      expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledWith({
        trackId: "t2",
        transposeEnabled: true,
      });

      const patched = getSongPatch()?.({
        tracks: [track("t1"), track("t2"), track("t3")],
      } as unknown as SongView);
      expect(patched?.tracks[0].transposeEnabled).toBe(true);
      expect(patched?.tracks[1].transposeEnabled).toBe(true);
    });

    it("transpose turns the whole selection off together", async () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) => track(id, { transposeEnabled: true }),
      });
      // Every track is enabled, so clicking t1 turns all three off.
      await handlers.handleTrackHeaderTransposeToggle("t1");

      expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledTimes(3);
      for (const id of ["t1", "t2", "t3"]) {
        expect(deps.updateTrackTransposeEnabled).toHaveBeenCalledWith({
          trackId: id,
          transposeEnabled: false,
        });
      }
    });

    it("a control on a track outside the selection edits only that track", () => {
      const { handlers, deps } = multiSetup({
        getSelectedTrackIds: () => ["t1", "t2"],
      });
      handlers.handleTrackHeaderMuteToggle("t3");

      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledTimes(1);
      expect(deps.patchTrackOptimisticMix).toHaveBeenCalledWith("t3", {
        muted: true,
      });
    });

    it("routing re-routes every selected track to the same output", async () => {
      const { handlers, deps } = multiSetup();
      await handlers.handleTrackHeaderAudioToChange("t1", "ext:2-3");

      expect(deps.commitTrackMixChange).toHaveBeenCalledTimes(3);
      for (const id of ["t1", "t2", "t3"]) {
        expect(deps.commitTrackMixChange).toHaveBeenCalledWith({
          trackId: id,
          audioTo: "ext:2-3",
        });
      }
      expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(17));
    });

    it("routing to 'inherit' skips tracks that have no parent folder", async () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) =>
          track(id, { parentTrackId: id === "t2" ? "f1" : null }),
      });
      await handlers.handleTrackHeaderAudioToChange("t1", "inherit");

      // Only t2 lives in a folder, so it is the only valid target.
      expect(deps.commitTrackMixChange).toHaveBeenCalledTimes(1);
      expect(deps.commitTrackMixChange).toHaveBeenCalledWith({
        trackId: "t2",
        audioTo: "inherit",
      });
    });

    it("routing to 'inherit' with no foldered track is a no-op", async () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) => track(id, { parentTrackId: null }),
      });
      await handlers.handleTrackHeaderAudioToChange("t1", "inherit");

      expect(deps.commitTrackMixChange).not.toHaveBeenCalled();
    });

    it("skips targets that no longer exist in the song", () => {
      const { handlers, deps } = multiSetup({
        findTrack: (id) => (id === "t2" ? null : track(id)),
      });
      handlers.handleTrackHeaderMuteToggle("t1");

      const touched = vi
        .mocked(deps.patchTrackOptimisticMix)
        .mock.calls.map(([id]) => id);
      expect(touched).toEqual(["t1", "t3"]);
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

    it("persists the new collapsed state so it survives reopening", async () => {
      const { handlers, deps } = setup();

      await handlers.handleTrackHeaderFolderToggle("f1");
      expect(deps.updateTrackCollapsed).toHaveBeenCalledWith({
        trackId: "f1",
        collapsed: true,
      });

      await handlers.handleTrackHeaderFolderToggle("f1");
      expect(deps.updateTrackCollapsed).toHaveBeenLastCalledWith({
        trackId: "f1",
        collapsed: false,
      });
    });

    it("optimistically patches the song and records the revision", async () => {
      const {
        handlers,
        optimisticallyAppliedRevisionsRef,
        getSongPatch,
      } = setup();

      await handlers.handleTrackHeaderFolderToggle("f1");

      expect(optimisticallyAppliedRevisionsRef.current.has(13)).toBe(true);
      const patched = getSongPatch()?.({
        projectRevision: 12,
        tracks: [track("f1"), track("t1")],
      } as unknown as SongView);
      expect(patched?.projectRevision).toBe(13);
      expect(
        patched?.tracks.find((entry) => entry.id === "f1")?.collapsed,
      ).toBe(true);
      expect(
        patched?.tracks.find((entry) => entry.id === "t1")?.collapsed,
      ).toBeUndefined();
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
