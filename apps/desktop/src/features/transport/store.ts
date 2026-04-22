import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { AudioMeterLevel, TransportSnapshot } from "./desktopApi";

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

type MeterDictionary = Record<string, TrackMeterState>;

type TransportStore = {
  meters: MeterDictionary;
  playback: TransportSnapshot | null;
  optimisticMix: Record<string, OptimisticMixState>;
  setMeters: (levels: AudioMeterLevel[] | MeterDictionary) => void;
  setPlaybackState: (playback: TransportSnapshot | null) => void;
  setOptimisticMix: (trackId: string, mix: OptimisticMixState | null) => void;
};

function normalizeMeters(levels: AudioMeterLevel[] | MeterDictionary): MeterDictionary {
  if (Array.isArray(levels)) {
    return Object.fromEntries(
      levels.map((level) => [
        level.trackId,
        {
          leftPeak: level.leftPeak,
          rightPeak: level.rightPeak,
        },
      ]),
    );
  }

  return levels;
}

export const useTransportStore = create<TransportStore>()(
  subscribeWithSelector((set) => ({
    meters: {},
    playback: null,
    optimisticMix: {},
    setMeters: (levels) => {
      set({ meters: normalizeMeters(levels) });
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
  })),
);
