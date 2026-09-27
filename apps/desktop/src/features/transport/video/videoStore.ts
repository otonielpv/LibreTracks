import { create } from "zustand";

import type { VideoAssetSummary, VideoLibraryStatus, VideoOutputStatus } from "../desktopApi";
import type { VideoAudioChoice } from "./videoAudioExtraction";

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
  /** Latest `video:output-status` (null until the first one arrives). */
  outputStatus: VideoOutputStatus | null;
  setOutputStatus: (status: VideoOutputStatus | null) => void;
  /** Emergency black (paso 13). Volatile: never saved, a restart clears it. */
  forcedBlack: boolean;
  setForcedBlack: (forcedBlack: boolean) => void;
  /** Idle screen forced from live control (paso 13). Volatile too. */
  forcedIdle: boolean;
  setForcedIdle: (forcedIdle: boolean) => void;
  /** Display setup wizard (paso 10): open, and on which step. */
  wizardOpen: boolean;
  wizardStep: number;
  openWizard: (step?: number) => void;
  closeWizard: () => void;
  /** Non-blocking notice on opening a session with video (paso 10). */
  setupNotice: VideoSetupNotice | null;
  /** Sessions where the user said "not now": asked once per session. */
  dismissedSetupSessions: string[];
  setSetupNotice: (notice: VideoSetupNotice | null) => void;
  dismissSetupNotice: () => void;
  /** "Extract the video's audio?" waiting for an answer (paso 11). */
  audioPrompt: VideoAudioPrompt | null;
  setAudioPrompt: (prompt: VideoAudioPrompt | null) => void;
  /** Extractions running: clip id → progress 0–1. */
  audioExtractions: Record<string, number>;
  setAudioExtraction: (clipId: string, fraction: number | null) => void;
  setPlaceAtPlayhead: (place: ((asset: VideoAssetSummary) => void) | null) => void;
  setMediaStatus: (status: VideoLibraryStatus | null) => void;
  setAssets: (assets: VideoAssetSummary[]) => void;
  /** `additive` keeps the rest (Ctrl/Shift click) and toggles `clipId`. */
  selectVideoClip: (clipId: string, additive: boolean) => void;
  setSelectedVideoClipIds: (clipIds: string[]) => void;
  clearVideoSelection: () => void;
};

export type VideoAudioPrompt = { count: number; resolve: (choice: VideoAudioChoice) => void };

export type VideoSetupNotice =
  | { kind: "configure"; sessionKey: string }
  | { kind: "displayMissing"; sessionKey: string; displayName: string };

export const INITIAL_VIDEO_STATE = {
  status: null,
  assets: [],
  selectedVideoClipIds: [],
  placeAtPlayhead: null,
  outputStatus: null,
  forcedBlack: false,
  forcedIdle: false,
  wizardOpen: false,
  wizardStep: 0,
  setupNotice: null,
  dismissedSetupSessions: [],
  audioPrompt: null,
  audioExtractions: {},
} satisfies Pick<
  VideoStoreState,
  | "status"
  | "assets"
  | "selectedVideoClipIds"
  | "placeAtPlayhead"
  | "outputStatus"
  | "forcedBlack"
  | "forcedIdle"
  | "wizardOpen"
  | "wizardStep"
  | "setupNotice"
  | "dismissedSetupSessions"
  | "audioPrompt"
  | "audioExtractions"
>;

export const useVideoStore = create<VideoStoreState>()((set) => ({
  ...INITIAL_VIDEO_STATE,
  setMediaStatus: (status) => set({ status }),
  setAssets: (assets) => set({ assets }),
  setPlaceAtPlayhead: (placeAtPlayhead) => set({ placeAtPlayhead }),
  setOutputStatus: (outputStatus) => set({ outputStatus }),
  setForcedBlack: (forcedBlack) => set({ forcedBlack }),
  setForcedIdle: (forcedIdle) => set({ forcedIdle }),
  openWizard: (step = 0) => set({ wizardOpen: true, wizardStep: step }),
  closeWizard: () => set({ wizardOpen: false, wizardStep: 0 }),
  setSetupNotice: (setupNotice) => set({ setupNotice }),
  setAudioPrompt: (audioPrompt) => set({ audioPrompt }),
  setAudioExtraction: (clipId, fraction) =>
    set((state) => {
      const next = { ...state.audioExtractions };
      if (fraction == null) delete next[clipId];
      else next[clipId] = fraction;
      return { audioExtractions: next };
    }),
  dismissSetupNotice: () =>
    set((state) => ({
      setupNotice: null,
      dismissedSetupSessions: state.setupNotice
        ? [...state.dismissedSetupSessions, state.setupNotice.sessionKey]
        : state.dismissedSetupSessions,
    })),
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
