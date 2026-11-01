import { create } from "zustand";

import type { AudioMeterLevel, RegionMeterLevel } from "./desktopApi";

/**
 * Niveles de los medidores (pistas y master de cada canción).
 *
 * Vivían en el transportStore. El motor manda un paquete cada 33 ms mientras
 * suena, y cada escritura en aquel store volvía a evaluar TODOS sus selectores
 * (el panel tiene una treintena) y daba un fotograma a cada bucle aparcado de la
 * puerta de fotogramas (`frameGate.ts` se suscribe a él). Los medidores sólo
 * los lee `tracks/meterTicker.ts`, con una suscripción, así que van aparte.
 *
 * Un store sobrevive al desmontaje: se resetea en `src/test/testUtils.tsx`.
 */

export type TrackMeterState = {
  leftPeak: number;
  rightPeak: number;
};

export type MeterDictionary = Record<string, TrackMeterState>;

/** Same shape as a track meter: the song master meter is stereo too. */
export type RegionMeterDictionary = Record<string, TrackMeterState>;

type MeterStore = {
  meters: MeterDictionary;
  regionMeters: RegionMeterDictionary;
  setMeters: (meters: MeterDictionary) => void;
  setRegionMeters: (meters: RegionMeterDictionary) => void;
};

export const INITIAL_METER_STATE = {
  meters: {} as MeterDictionary,
  regionMeters: {} as RegionMeterDictionary,
};

export const useMeterStore = create<MeterStore>()((set) => ({
  ...INITIAL_METER_STATE,
  setMeters: (meters) => {
    set({ meters });
  },
  setRegionMeters: (regionMeters) => {
    set({ regionMeters });
  },
}));

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
    meters[level.regionId] = {
      leftPeak: level.leftPeak ?? level.peak,
      rightPeak: level.rightPeak ?? level.peak,
    };
  }

  return meters;
}
