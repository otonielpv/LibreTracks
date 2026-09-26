import { create } from "zustand";

import type { VideoAssetSummary, VideoLibraryStatus } from "../desktopApi";

/**
 * Video state shared between zones of the transport panel: whether libmpv is
 * available, the video library, and which video clips are selected.
 *
 * Kept apart from `uiStore` so the video feature can grow (output status,
 * wizard, forced black) without touching the audio selection. It survives
 * unmount like every store: `src/test/testUtils.tsx` resets it before each
 * test.
 */
export type VideoStoreState = {
  status: VideoLibraryStatus | null;
  assets: VideoAssetSummary[];
  selectedVideoClipIds: string[];
  /** Put a library video on the timeline at the playhead. Published by
   * useVideoFeature on desktop; null elsewhere (the library then shows the
   * videos without the action). */
  placeAtPlayhead: ((asset: VideoAssetSummary) => void) | null;
  setPlaceAtPlayhead: (place: ((asset: VideoAssetSummary) => void) | null) => void;
  setMediaStatus: (status: VideoLibraryStatus | null) => void;
  setAssets: (assets: VideoAssetSummary[]) => void;
  /** `additive` keeps the rest (Ctrl/Shift click) and toggles `clipId`. */
  selectVideoClip: (clipId: string, additive: boolean) => void;
  setSelectedVideoClipIds: (clipIds: string[]) => void;
  clearVideoSelection: () => void;
};

export const INITIAL_VIDEO_STATE = {
  status: null,
  assets: [],
  selectedVideoClipIds: [],
  placeAtPlayhead: null,
} satisfies Pick<
  VideoStoreState,
  "status" | "assets" | "selectedVideoClipIds" | "placeAtPlayhead"
>;

export const useVideoStore = create<VideoStoreState>()((set) => ({
  ...INITIAL_VIDEO_STATE,
  setMediaStatus: (status) => set({ status }),
  setAssets: (assets) => set({ assets }),
  setPlaceAtPlayhead: (placeAtPlayhead) => set({ placeAtPlayhead }),
  selectVideoClip: (clipId, additive) =>
    set((state) => {
      if (!additive) {
        return { selectedVideoClipIds: [clipId] };
      }
      const selected = state.selectedVideoClipIds.includes(clipId)
        ? state.selectedVideoClipIds.filter((id) => id !== clipId)
        : [...state.selectedVideoClipIds, clipId];
      return { selectedVideoClipIds: selected };
    }),
  setSelectedVideoClipIds: (clipIds) => set({ selectedVideoClipIds: clipIds }),
  clearVideoSelection: () =>
    set((state) =>
      state.selectedVideoClipIds.length ? { selectedVideoClipIds: [] } : state,
    ),
}));
