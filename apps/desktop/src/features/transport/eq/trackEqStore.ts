import { create } from "zustand";

/**
 * Qué pista tiene abierto el editor de EQ (plan track-eq, D12). Un store, como
 * el editor de escenas: la cabecera DAW, la tira de Compacta/Setlist y la barra
 * de selección móvil lo abren con la misma llamada y el editor se monta una
 * sola vez.
 */
type TrackEqStore = {
  openTrackId: string | null;
  /**
   * Pistas a las que va cada cambio del editor abierto (plan track-eq-2,
   * paso 02). Con una sola pista es `[openTrackId]`; con varias seleccionadas
   * en el móvil, todas (la abierta primero).
   */
  targetTrackIds: string[];
  setOpenTrackId: (trackId: string | null, targetTrackIds?: string[]) => void;
};

export const useTrackEqStore = create<TrackEqStore>()((set) => ({
  openTrackId: null,
  targetTrackIds: [],
  setOpenTrackId: (openTrackId, targetTrackIds) =>
    set({
      openTrackId,
      targetTrackIds: openTrackId
        ? [openTrackId, ...(targetTrackIds ?? []).filter((id) => id !== openTrackId)]
        : [],
    }),
}));
