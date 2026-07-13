import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type GlobalJumpMode = "immediate" | "after_bars" | "next_marker";
export type SongJumpTrigger =
  | "immediate"
  | "region_end"
  | "after_bars"
  | "next_marker";
export type SongTransitionMode = "instant" | "fade_out";
export type VampMode = "section" | "bars";

/** Top-level view mode. The DAW view is the linear timeline; Compact is the
 * Ableton-Session-style grid where every column is a song. */
export type ViewMode = "daw" | "compact";

export const TIMELINE_DEFAULT_ZOOM_LEVEL = 7;
export const TIMELINE_DEFAULT_TRACK_HEIGHT = 76;
export const TIMELINE_DEFAULT_SNAP_ENABLED = true;
export const TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED = false;
export const DEFAULT_VIEW_MODE: ViewMode = "daw";

type TimelineUIState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  selectedTrackIds: string[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedSectionId: string | null;
  snapEnabled: boolean;
  followPlayheadEnabled: boolean;
  midiLearnMode: string | null;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  setCameraX: (cameraX: number) => void;
  setZoomLevel: (zoomLevel: number | ((currentZoomLevel: number) => number)) => void;
  setTrackHeight: (trackHeight: number | ((currentTrackHeight: number) => number)) => void;
  setSelectedTrackIds: (trackIds: string[]) => void;
  setSelectedClipId: (clipId: string | null) => void;
  setSelectedClipIds: (clipIds: string[]) => void;
  toggleClipSelection: (clipId: string) => void;
  setSelectedSectionId: (sectionId: string | null) => void;
  clearSelection: () => void;
  selectTrack: (trackIds: string[]) => void;
  selectClip: (clipId: string | null, trackId?: string | null) => void;
  selectSection: (sectionId: string | null) => void;
  setSnapEnabled: (enabled: boolean | ((currentSnapEnabled: boolean) => boolean)) => void;
  toggleSnapEnabled: () => void;
  setFollowPlayheadEnabled: (
    enabled: boolean | ((currentFollowPlayheadEnabled: boolean) => boolean),
  ) => void;
  toggleFollowPlayheadEnabled: () => void;
  setMidiLearnMode: (midiLearnMode: string | null) => void;
};

export const useTimelineUIStore = create<TimelineUIState>()(
  subscribeWithSelector((set) => ({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight: TIMELINE_DEFAULT_TRACK_HEIGHT,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedSectionId: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    followPlayheadEnabled: TIMELINE_DEFAULT_FOLLOW_PLAYHEAD_ENABLED,
    midiLearnMode: null,
    viewMode: DEFAULT_VIEW_MODE,
    setViewMode: (viewMode) => {
      set({ viewMode });
    },
    toggleViewMode: () => {
      set((state) => ({
        viewMode: state.viewMode === "daw" ? "compact" : "daw",
      }));
    },
    setCameraX: (cameraX) => {
      set({ cameraX: Number.isFinite(cameraX) ? Math.max(0, cameraX) : 0 });
    },
    setZoomLevel: (zoomLevel) => {
      set((state) => ({
        zoomLevel:
          typeof zoomLevel === "function" ? zoomLevel(state.zoomLevel) : zoomLevel,
      }));
    },
    setTrackHeight: (trackHeight) => {
      set((state) => ({
        trackHeight:
          typeof trackHeight === "function" ? trackHeight(state.trackHeight) : trackHeight,
      }));
    },
    setSelectedTrackIds: (selectedTrackIds) => {
      set({ selectedTrackIds, selectedClipId: null, selectedClipIds: [] });
    },
    setSelectedClipId: (selectedClipId) => {
      set({ selectedClipId, selectedClipIds: selectedClipId ? [selectedClipId] : [] });
    },
    setSelectedClipIds: (selectedClipIds) => {
      set({
        selectedTrackIds: [],
        selectedClipId: selectedClipIds.at(-1) ?? null,
        selectedClipIds,
        selectedSectionId: null,
      });
    },
    toggleClipSelection: (clipId) => {
      set((state) => {
        const selectedClipIds = state.selectedClipIds.includes(clipId)
          ? state.selectedClipIds.filter((id) => id !== clipId)
          : [...state.selectedClipIds, clipId];
        return {
          selectedTrackIds: [],
          selectedClipId: selectedClipIds.at(-1) ?? null,
          selectedClipIds,
          selectedSectionId: null,
        };
      });
    },
    setSelectedSectionId: (selectedSectionId) => {
      set({ selectedSectionId });
    },
    clearSelection: () => {
      set({
        selectedTrackIds: [],
        selectedClipId: null,
        selectedClipIds: [],
        selectedSectionId: null,
      });
    },
    selectTrack: (selectedTrackIds) => {
      set({
        selectedTrackIds,
        selectedClipId: null,
        selectedClipIds: [],
        selectedSectionId: null,
      });
    },
    selectClip: (clipId, _trackId = null) => {
      set({
        selectedTrackIds: [],
        selectedClipId: clipId,
        selectedClipIds: clipId ? [clipId] : [],
        selectedSectionId: null,
      });
    },
    selectSection: (sectionId) => {
      set({
        selectedTrackIds: [],
        selectedClipId: null,
        selectedClipIds: [],
        selectedSectionId: sectionId,
      });
    },
    setSnapEnabled: (snapEnabled) => {
      set((state) => ({
        snapEnabled:
          typeof snapEnabled === "function" ? snapEnabled(state.snapEnabled) : snapEnabled,
      }));
    },
    toggleSnapEnabled: () => {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },
    setFollowPlayheadEnabled: (followPlayheadEnabled) => {
      set((state) => ({
        followPlayheadEnabled:
          typeof followPlayheadEnabled === "function"
            ? followPlayheadEnabled(state.followPlayheadEnabled)
            : followPlayheadEnabled,
      }));
    },
    toggleFollowPlayheadEnabled: () => {
      set((state) => ({
        followPlayheadEnabled: !state.followPlayheadEnabled,
      }));
    },
    setMidiLearnMode: (midiLearnMode) => {
      set({ midiLearnMode });
    },
  })),
);
