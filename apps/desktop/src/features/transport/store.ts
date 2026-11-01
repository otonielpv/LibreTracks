import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { recordProductEvent } from "../telemetry/telemetry";

import type { TransportSnapshot } from "./desktopApi";
import type {
  PendingAudioImport,
  PendingAudioImportStatus,
} from "./library/pendingAudioImports";

// Meters moved to ./meterStore (they publish 30 times a second). Re-exported
// so existing imports keep working.
export {
  meterDictionaryFromLevels,
  regionMeterDictionaryFromLevels,
  type MeterDictionary,
  type RegionMeterDictionary,
  type TrackMeterState,
} from "./meterStore";

export type OptimisticMixState = Partial<{
  muted: boolean;
  solo: boolean;
  pan: number;
  volume: number;
}>;

export type OptimisticRegionMasterDictionary = Record<string, number>;

type TransportStore = {
  playback: TransportSnapshot | null;
  optimisticMix: Record<string, OptimisticMixState>;
  optimisticRegionMaster: OptimisticRegionMasterDictionary;
  pendingAudioImports: PendingAudioImport[];
  setPlaybackState: (playback: TransportSnapshot | null) => void;
  setOptimisticMix: (trackId: string, mix: OptimisticMixState | null) => void;
  setOptimisticRegionMaster: (regionId: string, gain: number | null) => void;
  addPendingAudioImports: (imports: PendingAudioImport[]) => void;
  updatePendingAudioImportStatus: (
    ids: string[],
    status: PendingAudioImportStatus,
    error?: string,
  ) => void;
  removePendingAudioImports: (ids: string[]) => void;
  markPendingAudioImportsFailed: (ids: string[], error: string) => void;
  /** Drop the placeholders of imports that already failed. They survive until
   * the user acknowledges the dialog, so a new import has to sweep them or the
   * old failure keeps being reported alongside the new one. */
  clearFailedPendingAudioImports: () => void;
};

function jumpSignature(playback: TransportSnapshot | null) {
  const jump = playback?.pendingMarkerJump;
  if (!jump) {
    return "";
  }

  return [
    jump.targetMarkerId,
    jump.targetMarkerName,
    jump.trigger,
    jump.executeAtSeconds.toFixed(6),
    typeof jump.targetSeconds === "number" ? jump.targetSeconds.toFixed(6) : "",
    jump.transition,
  ].join("|");
}

function automationJumpSignature(playback: TransportSnapshot | null) {
  const cue = playback?.pendingAutomationCue;
  if (!cue) {
    return "";
  }
  return [cue.cueId, cue.executeAtSeconds.toFixed(6)].join("|");
}

function vampSignature(playback: TransportSnapshot | null) {
  const vamp = playback?.activeVamp;
  if (!vamp) {
    return "";
  }

  return [vamp.startSeconds.toFixed(6), vamp.endSeconds.toFixed(6)].join("|");
}

function pitchPrepareSignature(playback: TransportSnapshot | null) {
  const pitch = playback?.pitch;
  if (!pitch) {
    return "";
  }

  return [
    pitch.pitchPrepareActive ? "1" : "0",
    pitch.pitchPreparePending ? "1" : "0",
    pitch.pitchPrepareStatus,
    pitch.pitchPrepareMessage,
    pitch.pitchPrepareProgress.toFixed(3),
    String(pitch.pitchProxyBlocksPending),
    String(pitch.pitchProxyBlocksMissing),
    String(pitch.pitchJobsPending),
    String(pitch.pitchJobsRunning),
    String(pitch.pitchJobsFailed),
  ].join("|");
}

function shouldPublishPlaybackSnapshot(
  current: TransportSnapshot | null,
  next: TransportSnapshot | null,
) {
  if (current === next) {
    return false;
  }
  if (!current || !next) {
    return true;
  }

  return (
    current.playbackState !== next.playbackState ||
    current.projectRevision !== next.projectRevision ||
    current.mixRevision !== next.mixRevision ||
    (current.activeMixSceneIds ?? []).join("|") !== (next.activeMixSceneIds ?? []).join("|") ||
    current.fadingToStop !== next.fadingToStop ||
    current.songGapVamp !== next.songGapVamp ||
    current.songDir !== next.songDir ||
    current.songFilePath !== next.songFilePath ||
    current.isNativeRuntime !== next.isNativeRuntime ||
    current.transportClock?.running !== next.transportClock?.running ||
    current.transportClock?.lastSeekPositionSeconds !==
      next.transportClock?.lastSeekPositionSeconds ||
    current.transportClock?.lastJumpPositionSeconds !==
      next.transportClock?.lastJumpPositionSeconds ||
    jumpSignature(current) !== jumpSignature(next) ||
    automationJumpSignature(current) !== automationJumpSignature(next) ||
    vampSignature(current) !== vampSignature(next) ||
    pitchPrepareSignature(current) !== pitchPrepareSignature(next)
  );
}

export const useTransportStore = create<TransportStore>()(
  subscribeWithSelector((set) => ({
    playback: null,
    optimisticMix: {},
    optimisticRegionMaster: {},
    pendingAudioImports: [],
    setOptimisticRegionMaster: (regionId, gain) => {
      set((state) => {
        if (gain === null) {
          if (!(regionId in state.optimisticRegionMaster)) {
            return state;
          }
          const next = { ...state.optimisticRegionMaster };
          delete next[regionId];
          return { optimisticRegionMaster: next };
        }
        return {
          optimisticRegionMaster: {
            ...state.optimisticRegionMaster,
            [regionId]: gain,
          },
        };
      });
    },
    setPlaybackState: (playback) => {
      if (playback?.activeVamp || playback?.songGapVamp) {
        recordProductEvent("feature_vamp");
      }
      set((state) =>
        shouldPublishPlaybackSnapshot(state.playback, playback)
          ? { playback }
          : state,
      );
    },
    setOptimisticMix: (trackId, mix) => {
      set((state) => {
        if (!mix || Object.keys(mix).length === 0) {
          if (!(trackId in state.optimisticMix)) {
            return state;
          }

          const nextOptimisticMix = { ...state.optimisticMix };
          delete nextOptimisticMix[trackId];
          return { optimisticMix: nextOptimisticMix };
        }

        return {
          optimisticMix: {
            ...state.optimisticMix,
            [trackId]: mix,
          },
        };
      });
    },
    addPendingAudioImports: (imports) => {
      if (!imports.length) {
        return;
      }

      set((state) => ({
        pendingAudioImports: [...state.pendingAudioImports, ...imports],
      }));
    },
    updatePendingAudioImportStatus: (ids, status, error) => {
      if (!ids.length) {
        return;
      }

      const idSet = new Set(ids);
      set((state) => ({
        pendingAudioImports: state.pendingAudioImports.map((item) =>
          idSet.has(item.id)
            ? {
                ...item,
                status,
                error,
              }
            : item,
        ),
      }));
    },
    removePendingAudioImports: (ids) => {
      if (!ids.length) {
        return;
      }

      const idSet = new Set(ids);
      set((state) => ({
        pendingAudioImports: state.pendingAudioImports.filter(
          (item) => !idSet.has(item.id),
        ),
      }));
    },
    clearFailedPendingAudioImports: () => {
      set((state) =>
        state.pendingAudioImports.some((item) => item.status === "failed")
          ? {
              pendingAudioImports: state.pendingAudioImports.filter(
                (item) => item.status !== "failed",
              ),
            }
          : state,
      );
    },
    markPendingAudioImportsFailed: (ids, error) => {
      if (!ids.length) {
        return;
      }

      const idSet = new Set(ids);
      set((state) => ({
        pendingAudioImports: state.pendingAudioImports.map((item) =>
          idSet.has(item.id)
            ? {
                ...item,
                status: "failed",
                error,
              }
            : item,
        ),
      }));
    },
  })),
);
