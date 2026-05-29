import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type {
  AudioMeterLevel,
  RegionMeterLevel,
  TransportSnapshot,
} from "./desktopApi";
import type {
  PendingAudioImport,
  PendingAudioImportStatus,
} from "./pendingAudioImports";

export type TrackMeterState = {
  leftPeak: number;
  rightPeak: number;
};

export type OptimisticMixState = Partial<{
  muted: boolean;
  solo: boolean;
  pan: number;
  volume: number;
}>;

export type MeterDictionary = Record<string, TrackMeterState>;

export type RegionMeterDictionary = Record<string, number>;

export type OptimisticRegionMasterDictionary = Record<string, number>;

type TransportStore = {
  meters: MeterDictionary;
  regionMeters: RegionMeterDictionary;
  playback: TransportSnapshot | null;
  optimisticMix: Record<string, OptimisticMixState>;
  optimisticRegionMaster: OptimisticRegionMasterDictionary;
  pendingAudioImports: PendingAudioImport[];
  setMeters: (meters: MeterDictionary) => void;
  setRegionMeters: (meters: RegionMeterDictionary) => void;
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
};

export function meterDictionaryFromLevels(
  levels: AudioMeterLevel[],
): MeterDictionary {
  const meters: MeterDictionary = {};

  for (const level of levels) {
    meters[level.trackId] = {
      leftPeak: level.leftPeak,
      rightPeak: level.rightPeak,
    };
  }

  return meters;
}

export function regionMeterDictionaryFromLevels(
  levels: RegionMeterLevel[],
): RegionMeterDictionary {
  const meters: RegionMeterDictionary = {};

  for (const level of levels) {
    meters[level.regionId] = level.peak;
  }

  return meters;
}

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
    jump.transition,
  ].join("|");
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
    current.songDir !== next.songDir ||
    current.songFilePath !== next.songFilePath ||
    current.isNativeRuntime !== next.isNativeRuntime ||
    current.transportClock?.running !== next.transportClock?.running ||
    current.transportClock?.lastSeekPositionSeconds !==
      next.transportClock?.lastSeekPositionSeconds ||
    current.transportClock?.lastJumpPositionSeconds !==
      next.transportClock?.lastJumpPositionSeconds ||
    jumpSignature(current) !== jumpSignature(next) ||
    vampSignature(current) !== vampSignature(next) ||
    pitchPrepareSignature(current) !== pitchPrepareSignature(next)
  );
}

export const useTransportStore = create<TransportStore>()(
  subscribeWithSelector((set) => ({
    meters: {},
    regionMeters: {},
    playback: null,
    optimisticMix: {},
    optimisticRegionMaster: {},
    pendingAudioImports: [],
    setMeters: (meters) => {
      set({ meters });
    },
    setRegionMeters: (regionMeters) => {
      set({ regionMeters });
    },
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
