import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { AudioMeterLevel, TransportSnapshot } from "./desktopApi";
import type { PendingAudioImport, PendingAudioImportStatus } from "./pendingAudioImports";

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

type TransportStore = {
  meters: MeterDictionary;
  playback: TransportSnapshot | null;
  optimisticMix: Record<string, OptimisticMixState>;
  pendingAudioImports: PendingAudioImport[];
  setMeters: (meters: MeterDictionary) => void;
  setPlaybackState: (playback: TransportSnapshot | null) => void;
  setOptimisticMix: (trackId: string, mix: OptimisticMixState | null) => void;
  addPendingAudioImports: (imports: PendingAudioImport[]) => void;
  updatePendingAudioImportStatus: (
    ids: string[],
    status: PendingAudioImportStatus,
    error?: string,
  ) => void;
  removePendingAudioImports: (ids: string[]) => void;
  markPendingAudioImportsFailed: (ids: string[], error: string) => void;
};

export function meterDictionaryFromLevels(levels: AudioMeterLevel[]): MeterDictionary {
  const meters: MeterDictionary = {};

  for (const level of levels) {
    meters[level.trackId] = {
      leftPeak: level.leftPeak,
      rightPeak: level.rightPeak,
    };
  }

  return meters;
}

export const useTransportStore = create<TransportStore>()(
  subscribeWithSelector((set) => ({
    meters: {},
    playback: null,
    optimisticMix: {},
    pendingAudioImports: [],
    setMeters: (meters) => {
      set({ meters });
    },
    setPlaybackState: (playback) => {
      set({ playback });
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
        pendingAudioImports: state.pendingAudioImports.filter((item) => !idSet.has(item.id)),
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
