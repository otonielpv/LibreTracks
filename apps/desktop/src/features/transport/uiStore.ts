import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type GlobalJumpMode = "immediate" | "after_bars" | "next_marker";
export type SongJumpTrigger = "immediate" | "region_end" | "after_bars";
export type SongTransitionMode = "instant" | "fade_out";

export const TIMELINE_DEFAULT_ZOOM_LEVEL = 7;
export const TIMELINE_DEFAULT_TRACK_HEIGHT = 94;
export const TIMELINE_DEFAULT_SNAP_ENABLED = true;
export const TIMELINE_DEFAULT_GLOBAL_JUMP_MODE: GlobalJumpMode = "immediate";
export const TIMELINE_DEFAULT_GLOBAL_JUMP_BARS = 4;
export const TIMELINE_DEFAULT_SONG_JUMP_TRIGGER: SongJumpTrigger = "immediate";
export const TIMELINE_DEFAULT_SONG_JUMP_BARS = 4;
export const TIMELINE_DEFAULT_SONG_TRANSITION_MODE: SongTransitionMode = "instant";

type TimelineUIState = {
  cameraX: number;
  zoomLevel: number;
  trackHeight: number;
  selectedTrackIds: string[];
  selectedClipId: string | null;
  selectedSectionId: string | null;
  snapEnabled: boolean;
  globalJumpMode: GlobalJumpMode;
  globalJumpBars: number;
  songJumpTrigger: SongJumpTrigger;
  songJumpBars: number;
  songTransitionMode: SongTransitionMode;
  setCameraX: (cameraX: number) => void;
  setZoomLevel: (zoomLevel: number | ((currentZoomLevel: number) => number)) => void;
  setTrackHeight: (trackHeight: number | ((currentTrackHeight: number) => number)) => void;
  setSelectedTrackIds: (trackIds: string[]) => void;
  setSelectedClipId: (clipId: string | null) => void;
  setSelectedSectionId: (sectionId: string | null) => void;
  clearSelection: () => void;
  selectTrack: (trackIds: string[]) => void;
  selectClip: (clipId: string | null, trackId?: string | null) => void;
  selectSection: (sectionId: string | null) => void;
  setSnapEnabled: (enabled: boolean | ((currentSnapEnabled: boolean) => boolean)) => void;
  toggleSnapEnabled: () => void;
  setGlobalJumpMode: (mode: GlobalJumpMode) => void;
  setGlobalJumpBars: (bars: number) => void;
  setSongJumpTrigger: (trigger: SongJumpTrigger) => void;
  setSongJumpBars: (bars: number) => void;
  setSongTransitionMode: (mode: SongTransitionMode) => void;
};

export const useTimelineUIStore = create<TimelineUIState>()(
  subscribeWithSelector((set) => ({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight: TIMELINE_DEFAULT_TRACK_HEIGHT,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedSectionId: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    globalJumpMode: TIMELINE_DEFAULT_GLOBAL_JUMP_MODE,
    globalJumpBars: TIMELINE_DEFAULT_GLOBAL_JUMP_BARS,
    songJumpTrigger: TIMELINE_DEFAULT_SONG_JUMP_TRIGGER,
    songJumpBars: TIMELINE_DEFAULT_SONG_JUMP_BARS,
    songTransitionMode: TIMELINE_DEFAULT_SONG_TRANSITION_MODE,
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
      set({ selectedTrackIds });
    },
    setSelectedClipId: (selectedClipId) => {
      set({ selectedClipId });
    },
    setSelectedSectionId: (selectedSectionId) => {
      set({ selectedSectionId });
    },
    clearSelection: () => {
      set({
        selectedTrackIds: [],
        selectedClipId: null,
        selectedSectionId: null,
      });
    },
    selectTrack: (selectedTrackIds) => {
      set({
        selectedTrackIds,
        selectedClipId: null,
        selectedSectionId: null,
      });
    },
    selectClip: (clipId, _trackId = null) => {
      set({
        selectedTrackIds: [],
        selectedClipId: clipId,
        selectedSectionId: null,
      });
    },
    selectSection: (sectionId) => {
      set({
        selectedTrackIds: [],
        selectedClipId: null,
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
    setGlobalJumpMode: (globalJumpMode) => {
      set({ globalJumpMode });
    },
    setGlobalJumpBars: (globalJumpBars) => {
      set({ globalJumpBars: Math.max(1, Math.floor(globalJumpBars) || 1) });
    },
    setSongJumpTrigger: (songJumpTrigger) => {
      set({ songJumpTrigger });
    },
    setSongJumpBars: (songJumpBars) => {
      set({ songJumpBars: Math.max(1, Math.floor(songJumpBars) || 1) });
    },
    setSongTransitionMode: (songTransitionMode) => {
      set({ songTransitionMode });
    },
  })),
);
