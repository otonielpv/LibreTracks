import { create } from "zustand";

/**
 * "Solo pistas de la canción activa" en el mezclador. Un único interruptor
 * para Compacta y Setlist: apagarlo en una vista lo apaga en la otra.
 *
 * Encendido por defecto; se recuerda entre sesiones. La clave es la que ya
 * usaba Compacta, así se respeta lo que cada usuario tenía guardado.
 */
export const MIXER_FILTER_STORAGE_KEY = "libretracks.compactMixer.filterActiveSong";

function readStoredFilter(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(MIXER_FILTER_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeStoredFilter(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIXER_FILTER_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Cuota o modo privado: el interruptor sigue funcionando en memoria.
  }
}

interface MixerFilterState {
  filterActiveSong: boolean;
  toggleFilterActiveSong: () => void;
}

export const useMixerFilterStore = create<MixerFilterState>((set, get) => ({
  filterActiveSong: readStoredFilter(),
  toggleFilterActiveSong: () => {
    const next = !get().filterActiveSong;
    writeStoredFilter(next);
    set({ filterActiveSong: next });
  },
}));
