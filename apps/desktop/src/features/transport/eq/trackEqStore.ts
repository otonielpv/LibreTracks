import { create } from "zustand";

/**
 * Qué pista tiene abierto el editor de EQ (plan track-eq, D12). Un store, como
 * el editor de escenas: la cabecera DAW, la tira de Compacta/Setlist y la barra
 * de selección móvil lo abren con la misma llamada y el editor se monta una
 * sola vez.
 */
type TrackEqStore = {
  openTrackId: string | null;
  setOpenTrackId: (trackId: string | null) => void;
};

export const useTrackEqStore = create<TrackEqStore>()((set) => ({
  openTrackId: null,
  setOpenTrackId: (openTrackId) => set({ openTrackId }),
}));
